// The Console's clock. Every 30 s:
//   - health probe of each live agency once a minute, alert after N failures in a row;
//   - central cron: each instance's /api/instance/cron catalog, run on schedule (UTC);
//   - nightly backups, retention purge, stale-backup alert;
//   - monthly restore drill;
//   - nightly backup of the Console's own database; off-site copy of every encrypted backup;
//   - re-check of custom domains waiting for their DNS record.
// Each piece is an exported function of (platform, now) so the tests can drive time.

import { listAgencies, readState, type Agency } from './agencies.ts';
import { healthReason } from './health-reason.ts';
import { openAlert, resolveAlert } from './alerts.ts';
import { cronMatches, parseCron } from './cron.ts';
import { plannedSteps } from './jobs/handlers.ts';
import { backupConsole, instanceApi, probe, recordHealth } from './jobs/ops.ts';
import { enqueue, type JobKind } from './jobs/queue.ts';
import { errorFields, log } from './log.ts';
import type { Platform } from './platform.ts';

const LIVE = new Set(['active', 'suspended']);
const CATALOG_TTL_MS = 6 * 3_600_000;
const DOMAIN_RECHECK_MS = 5 * 60_000;

async function busyAgencies(p: Platform): Promise<Set<string>> {
  const rows = await p.sql<{ agencyId: string }[]>`SELECT DISTINCT agency_id FROM jobs WHERE status = 'running'`;
  return new Set(rows.map((r) => r.agencyId));
}

async function mark(p: Platform, name: string, value: string): Promise<boolean> {
  // true the first time a (name, value) is set: "did the nightly backups of 2026-10-26 already start?"
  const rows = await p.sql`
    INSERT INTO scheduler_marks (name, value) VALUES (${name}, ${value})
    ON CONFLICT (name) DO UPDATE SET value = excluded.value, at = now() WHERE scheduler_marks.value <> excluded.value
    RETURNING name`;
  return rows.length > 0;
}

function auto(p: Platform, agency: Agency, kind: JobKind, params: Record<string, unknown> = {}) {
  return enqueue(p.sql, { agencyId: agency.id, kind, params, steps: plannedSteps(kind, params), dedupe: true });
}

// ---------- health ----------

export async function healthPass(p: Platform, now: Date): Promise<void> {
  const busy = await busyAgencies(p);
  const due = (await listAgencies(p.sql)).filter(
    // an upgrade or restore takes the instance down on purpose
    (a) => LIVE.has(a.status) && !busy.has(a.id) && !(a.healthCheckedAt && now.getTime() - a.healthCheckedAt.getTime() < 55_000),
  );
  // In parallel: one slow instance (30 s timeout) must not delay the others.
  await Promise.all(due.map((a) => checkOne(p, a)));
}

async function checkOne(p: Platform, a: Agency): Promise<void> {
  const r = await probe(p, a);
  const failures = await recordHealth(p, a, r);
  if (r.ok) {
    await resolveAlert(p.sql, p.infra.notify, { agencyId: a.id, agencyName: a.name, key: 'health', message: 'Instance de nouveau en ligne' });
  } else if (failures >= p.settings.healthFailuresBeforeAlert) {
    await openAlert(p.sql, p.infra.notify, {
      agencyId: a.id,
      agencyName: a.name,
      kind: 'health',
      key: 'health',
      message: `Instance hors ligne depuis ${failures} contrôles (https://${a.primaryHost}) : ${healthReason(r.snapshot.error)}`,
    });
  }
}

// ---------- central cron ----------

type CronRow = { agencyId: string; jobId: string; schedule: string; lastRunAt: Date | null; failures: number };

const inFlight = new Set<string>();

async function refreshCatalog(p: Platform, a: Agency, now: Date): Promise<CronRow[]> {
  const rows = await p.sql<(CronRow & { refreshedAt: Date | null })[]>`
    SELECT agency_id, job_id, schedule, last_run_at, failures, (SELECT value::timestamptz FROM scheduler_marks WHERE name = ${`catalog:${a.id}`}) AS refreshed_at
    FROM agency_cron WHERE agency_id = ${a.id}`;
  const refreshed = rows[0]?.refreshedAt;
  if (rows.length && refreshed && now.getTime() - refreshed.getTime() < CATALOG_TTL_MS) return rows;
  const state = readState(p.sealer, a);
  if (!state) return rows;
  try {
    const res = await instanceApi(p, state)('GET', '/api/instance/cron');
    const jobs = (res.json?.jobs ?? []) as { id: string; schedule: string; description?: string }[];
    if (res.status !== 200 || !Array.isArray(jobs)) return rows;
    for (const j of jobs) {
      if (typeof j.id !== 'string' || !parseCron(String(j.schedule))) continue;
      await p.sql`
        INSERT INTO agency_cron (agency_id, job_id, schedule, description) VALUES (${a.id}, ${j.id}, ${j.schedule}, ${j.description ?? null})
        ON CONFLICT (agency_id, job_id) DO UPDATE SET schedule = excluded.schedule, description = excluded.description`;
    }
    const ids = jobs.map((j) => j.id);
    await p.sql`DELETE FROM agency_cron WHERE agency_id = ${a.id} AND NOT (job_id = ANY(${ids}))`;
    await mark(p, `catalog:${a.id}`, now.toISOString());
  } catch (err) {
    log.warn('cron.catalog_failed', { agency: a.slug, ...errorFields(err) });
    return rows;
  }
  return p.sql<CronRow[]>`SELECT agency_id, job_id, schedule, last_run_at, failures FROM agency_cron WHERE agency_id = ${a.id}`;
}

async function runCron(p: Platform, a: Agency, row: CronRow, now: Date): Promise<void> {
  const flight = `${a.id}:${row.jobId}`;
  if (inFlight.has(flight)) return; // the previous run is still going (email sequences can take minutes)
  inFlight.add(flight);
  try {
    const state = readState(p.sealer, a);
    if (!state) return;
    let ok = false;
    let status = 0;
    let error: string | null = null;
    try {
      const res = await instanceApi(p, state)('POST', '/api/instance/cron', JSON.stringify({ job: row.jobId }), { 'Content-Type': 'application/json' });
      status = res.status;
      ok = res.status === 200 && res.json?.ok !== false;
      if (!ok) error = JSON.stringify(res.json)?.slice(0, 500) ?? null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const [r] = await p.sql<{ failures: number }[]>`
      UPDATE agency_cron SET last_run_at = ${now}, last_ok = ${ok}, last_status = ${status || null}, last_error = ${error},
        failures = CASE WHEN ${ok} THEN 0 ELSE failures + 1 END
      WHERE agency_id = ${a.id} AND job_id = ${row.jobId} RETURNING failures`;
    const key = `cron:${row.jobId}`;
    if (ok) await resolveAlert(p.sql, p.infra.notify, { agencyId: a.id, agencyName: a.name, key, message: `Tâche planifiée ${row.jobId} rétablie` });
    else if ((r?.failures ?? 0) >= 3) {
      await openAlert(p.sql, p.infra.notify, { agencyId: a.id, agencyName: a.name, kind: 'cron', key, message: `La tâche planifiée « ${row.jobId} » échoue (${r?.failures} fois de suite) : ${error ?? `HTTP ${status}`}` });
    }
  } finally {
    inFlight.delete(flight);
  }
}

/** Starts this minute's cron calls; returns them so a caller (tests) can wait for them. */
export async function cronPass(p: Platform, now: Date): Promise<Promise<void>[]> {
  if (!p.settings.centralCron) return [];
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  if (!(await mark(p, 'cron:minute', minute.toISOString()))) return []; // this minute was already dispatched
  const started: Promise<void>[] = [];
  for (const a of await listAgencies(p.sql)) {
    if (a.status !== 'active') continue; // a suspended instance runs nothing anyway
    for (const row of await refreshCatalog(p, a, now)) {
      if (cronMatches(row.schedule, minute)) started.push(runCron(p, a, row, minute).catch((err) => log.error('cron.run_failed', errorFields(err))));
    }
  }
  return started;
}

// ---------- backups ----------

export async function backupPass(p: Platform, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const agencies = (await listAgencies(p.sql)).filter((a) => LIVE.has(a.status));

  if (now.getUTCHours() === p.settings.backupHourUtc && (await mark(p, 'nightly-backups', day))) {
    for (const a of agencies) await auto(p, a, 'backup', { reason: 'nightly' });
    log.info('scheduler.nightly_backups', { count: agencies.length });
    void consoleBackupInBackground(p, 'nightly');
  }

  // The Console's own database: nothing in 36 h (for a Console older than that) is an alert.
  const [last] = await p.sql<{ at: Date | null; first: Date | null }[]>`
    SELECT (SELECT max(created_at) FROM console_backups) AS at, (SELECT min(applied_at) FROM schema_migrations WHERE name >= '0002') AS first`;
  if (last?.first && now.getTime() - new Date(last.first).getTime() > 36 * 3_600_000 && (!last.at || now.getTime() - new Date(last.at).getTime() > 36 * 3_600_000)) {
    await openAlert(p.sql, p.infra.notify, {
      agencyId: null,
      kind: 'backup',
      key: 'console-backup',
      message: last.at ? `Console : aucune sauvegarde de sa base depuis le ${new Date(last.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Console : sa propre base n’a jamais été sauvegardée',
    });
  }

  // Stale backups: nothing in 36 h for an agency older than that.
  for (const a of agencies) {
    const old = now.getTime() - a.createdAt.getTime() > 36 * 3_600_000;
    const stale = !a.lastBackupAt || now.getTime() - a.lastBackupAt.getTime() > 36 * 3_600_000;
    if (old && stale) {
      await openAlert(p.sql, p.infra.notify, {
        agencyId: a.id,
        agencyName: a.name,
        kind: 'backup',
        key: 'backup',
        message: a.lastBackupAt ? `Aucune sauvegarde depuis le ${a.lastBackupAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Aucune sauvegarde',
      });
    }
  }

  // Retention, hourly. The newest backup of an agency that still exists is never removed.
  if (await mark(p, 'retention', now.toISOString().slice(0, 13))) {
    const expired = await p.sql<{ id: string; objectKey: string; offsiteAt: Date | null }[]>`
      SELECT b.id, b.object_key, b.offsite_at FROM backups b JOIN agencies a ON a.id = b.agency_id
      WHERE b.removed_at IS NULL AND b.expires_at < ${now}
        AND (a.status = 'deleted' OR b.id <> (SELECT id FROM backups x WHERE x.agency_id = b.agency_id AND x.removed_at IS NULL ORDER BY created_at DESC LIMIT 1))`;
    for (const b of expired) {
      try {
        await p.infra.backups.remove(b.objectKey);
        if (b.offsiteAt) await p.infra.offsite?.remove(b.objectKey);
        await p.sql`UPDATE backups SET removed_at = now() WHERE id = ${b.id}`;
      } catch (err) {
        log.warn('retention.remove_failed', { key: b.objectKey, ...errorFields(err) });
      }
    }
    // The Console's own backups: same retention, the newest always kept.
    const expiredConsole = await p.sql<{ id: string; objectKey: string; offsiteAt: Date | null }[]>`
      SELECT id, object_key, offsite_at FROM console_backups
      WHERE removed_at IS NULL AND expires_at < ${now}
        AND id <> (SELECT id FROM console_backups WHERE removed_at IS NULL ORDER BY created_at DESC LIMIT 1)`;
    for (const b of expiredConsole) {
      try {
        await p.infra.backups.remove(b.objectKey);
        if (b.offsiteAt) await p.infra.offsite?.remove(b.objectKey);
        await p.sql`UPDATE console_backups SET removed_at = now() WHERE id = ${b.id}`;
      } catch (err) {
        log.warn('retention.remove_failed', { key: b.objectKey, ...errorFields(err) });
      }
    }
  }

  // Monthly restore drill, two hours after the backups of the drill day.
  const drillHour = (p.settings.backupHourUtc + 2) % 24;
  if (now.getUTCDate() === p.settings.drillDay && now.getUTCHours() === drillHour && (await mark(p, 'restore-drill', day.slice(0, 7)))) {
    for (const a of agencies) if (a.lastBackupAt) await auto(p, a, 'restore_drill');
  }
}

let consoleBackupRunning = false;

/** A Console self-backup is running (the Plateforme page hides its button meanwhile). */
export const consoleBackupBusy = () => consoleBackupRunning;

/** pg_dump of the Console's database outside the tick; a failure opens an alert. Returns the run (tests wait on it). */
export function consoleBackupInBackground(p: Platform, reason: 'nightly' | 'manual'): Promise<void> {
  if (consoleBackupRunning) return Promise.resolve();
  consoleBackupRunning = true;
  return backupConsole(p, reason)
    .then(async (b) => {
      log.info('console_backup.done', { size: b.size, reason });
      await resolveAlert(p.sql, p.infra.notify, { agencyId: null, key: 'console-backup', message: 'Console : sauvegarde de sa base de nouveau à jour' });
    })
    .catch(async (err) => {
      log.error('console_backup.failed', errorFields(err));
      await openAlert(p.sql, p.infra.notify, {
        agencyId: null,
        kind: 'backup',
        key: 'console-backup',
        message: `Console : la sauvegarde de sa propre base a échoué : ${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => undefined);
    })
    .finally(() => {
      consoleBackupRunning = false;
    });
}

// ---------- off-site copy (Backblaze B2) ----------

const OFFSITE_LATE_MS = 6 * 3_600_000;
let offsiteRunning = false;

type OffsiteRow = { kind: 'backups' | 'exports' | 'console_backups'; id: string; objectKey: string };

/**
 * Copies encrypted backups and exports to the off-site bucket, a few per tick, oldest first. A copy
 * still missing 6 h after its backup opens an alert. Unencrypted (older) objects are never sent.
 */
export async function offsitePass(p: Platform, now: Date, batch = 5): Promise<void> {
  const offsite = p.infra.offsite;
  if (!offsite || offsiteRunning) return;
  offsiteRunning = true;
  try {
    const rows = await p.sql<OffsiteRow[]>`
      SELECT * FROM (
        SELECT 'backups' AS kind, id, object_key, created_at FROM backups WHERE encrypted AND offsite_at IS NULL AND removed_at IS NULL
        UNION ALL SELECT 'exports', id, object_key, created_at FROM exports WHERE encrypted AND offsite_at IS NULL
        UNION ALL SELECT 'console_backups', id, object_key, created_at FROM console_backups WHERE encrypted AND offsite_at IS NULL AND removed_at IS NULL) x
      ORDER BY created_at LIMIT ${batch}`;
    for (const r of rows) {
      const table = p.sql(r.kind);
      try {
        await offsite.put(r.objectKey, await p.infra.backups.get(r.objectKey));
        await p.sql`UPDATE ${table} SET offsite_at = ${now}, offsite_error = NULL WHERE id = ${r.id}`;
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        log.warn('offsite.copy_failed', { key: r.objectKey, error: msg });
        await p.sql`UPDATE ${table} SET offsite_error = ${msg} WHERE id = ${r.id}`;
      }
    }
    const [late] = await p.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT created_at FROM backups WHERE encrypted AND offsite_at IS NULL AND removed_at IS NULL
        UNION ALL SELECT created_at FROM exports WHERE encrypted AND offsite_at IS NULL
        UNION ALL SELECT created_at FROM console_backups WHERE encrypted AND offsite_at IS NULL AND removed_at IS NULL) x
      WHERE created_at < ${new Date(now.getTime() - OFFSITE_LATE_MS)}`;
    if ((late?.n ?? 0) > 0) {
      await openAlert(p.sql, p.infra.notify, {
        agencyId: null,
        kind: 'backup',
        key: 'offsite',
        message: `Copie hors site en retard : ${late!.n} sauvegarde(s) pas encore copiée(s) vers ${offsite.label} après 6 h`,
      });
    } else {
      await resolveAlert(p.sql, p.infra.notify, { agencyId: null, key: 'offsite', message: 'Copie hors site de nouveau à jour' });
    }
  } finally {
    offsiteRunning = false;
  }
}

// ---------- custom domains waiting for DNS ----------

export async function domainPass(p: Platform, now: Date): Promise<void> {
  const rows = await p.sql<{ id: string }[]>`
    SELECT a.id FROM agencies a
    WHERE a.domain_pending AND a.status IN ('active', 'suspended')
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.agency_id = a.id AND j.kind = 'domain'
                      AND (j.status IN ('queued', 'running') OR j.finished_at > ${new Date(now.getTime() - DOMAIN_RECHECK_MS)}))`;
  for (const r of rows) await enqueue(p.sql, { agencyId: r.id, kind: 'domain', steps: plannedSteps('domain'), dedupe: true });
}

export async function tick(p: Platform, now: Date): Promise<Promise<void>[]> {
  const started: Promise<void>[] = [];
  for (const [name, pass] of [
    ['cron', async () => started.push(...(await cronPass(p, now)))],
    ['health', () => healthPass(p, now)],
    ['backups', () => backupPass(p, now)],
    ['domains', () => domainPass(p, now)],
    ['offsite', () => offsitePass(p, now)],
  ] as const) {
    try {
      await pass();
    } catch (err) {
      log.error(`scheduler.${name}_failed`, errorFields(err));
    }
  }
  return started;
}

export function startScheduler(p: Platform, everyMs = 30_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick(p, p.infra.now())
      .catch((err) => log.error('scheduler.tick_failed', errorFields(err)))
      .finally(() => (running = false));
  }, everyMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
