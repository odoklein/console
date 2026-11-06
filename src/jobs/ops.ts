// Operations shared by the job handlers and the scheduler: run the vendored provisioning,
// probe an instance, back up a database, export an agency's data.

import { pipeline } from 'node:stream';
import type { Readable } from 'node:stream';
import { LOGO_DIR, readLogo, readState, stateStore, updateAgency, type Agency, type HealthSnapshot } from '../agencies.ts';
import { decryptStream, encryptStream } from '../backup-crypto.ts';
import type { DbTarget } from '../infra/types.ts';
import type { Platform } from '../platform.ts';
import { sharedEnvFor } from '../integration-keys.ts';
import { deriveNames, type AgencyConfig } from '../provision/plan.ts';
import { provision, scrub, type Deps, type RunReport, type State } from '../provision/run.ts';

export class JobError extends Error {}

export function requireState(p: Platform, agency: Agency): State {
  const state = readState(p.sealer, agency);
  if (!state) throw new JobError("Cette agence n'a pas encore été créée sur les serveurs (aucun état de provisionnement).");
  return state;
}

export function instanceApi(p: Platform, state: State, host = state.primaryHost) {
  return p.infra.instance(p.settings.baseUrlOverride ?? `https://${host}`, state.secrets.instanceAdminSecret);
}

export function dbTarget(p: Platform, agency: Agency, state: State, database?: string): DbTarget {
  const names = deriveNames(agency.slug, p.settings.platformDomain);
  return {
    ...p.settings.pgFromConsole,
    database: database ?? names.dbName,
    user: names.dbRole,
    password: state.secrets.dbPassword,
  };
}

/** Config as the vendored runner wants it (the Console's extras stay out of the instance). */
export function agencyConfig(agency: Agency): AgencyConfig {
  const { extra: _extra, ...config } = agency.config;
  return config;
}

export async function runProvision(
  p: Platform,
  agency: Agency,
  input: { imageTag: string; only?: string[]; log(line: string): void; onStep?: Deps['onStep']; onInvite?: Deps['onInvite'] },
): Promise<{ report: RunReport; state: State }> {
  const s = p.settings;
  const store = stateStore(p.sql, p.sealer, agency.id);
  const deps: Deps = {
    pg: p.infra.pg,
    storage: p.infra.storage,
    runDbJob: p.infra.runDbJob,
    dokploy: p.infra.dokploy,
    instance: p.infra.instance,
    dns: p.infra.dns,
    proxy: p.infra.proxy,
    readFile: (path) => readLogo(p.sql, agency.id, path),
    log: input.log,
    sleep: p.infra.sleep,
    now: p.infra.now,
    onStep: input.onStep,
    onInvite: input.onInvite,
  };
  const report = await provision(
    {
      config: agencyConfig(agency),
      configDir: LOGO_DIR,
      platformDomain: s.platformDomain,
      pg: s.pg,
      minio: s.minio,
      shared: sharedEnvFor(agency, s.shared),
      imageRepo: s.imageRepo,
      imageTag: input.imageTag,
      dokployProject: s.dokployProject,
      dokployEnvironmentId: s.dokployEnvironmentId,
      registry: s.registry,
      baseUrlOverride: s.baseUrlOverride,
      only: input.only,
      healthTimeoutMs: s.healthTimeoutMs,
    },
    deps,
    { load: () => store.load(), save: (st) => store.save(st) },
  );
  const state = (await store.load())!;
  return { report, state };
}

// ---------- health ----------

export async function probe(p: Platform, agency: Agency): Promise<{ ok: boolean; snapshot: HealthSnapshot }> {
  const state = readState(p.sealer, agency);
  if (!state) return { ok: false, snapshot: { error: 'pas encore provisionnée' } };
  try {
    const res = await instanceApi(p, state)('GET', '/api/instance/health');
    if (res.status !== 200) return { ok: false, snapshot: { error: `HTTP ${res.status}` } };
    const j = (res.json ?? {}) as HealthSnapshot;
    const snapshot: HealthSnapshot = { version: j.version, schemaVersion: j.schemaVersion ?? null, dbOk: j.dbOk === true, license: j.license };
    if (!snapshot.dbOk) snapshot.error = 'base de données injoignable';
    return { ok: snapshot.dbOk === true, snapshot };
  } catch (err) {
    return { ok: false, snapshot: { error: scrub(err instanceof Error ? err.message : String(err), state.secrets).slice(0, 300) } };
  }
}

export async function recordHealth(p: Platform, agency: Agency, result: { ok: boolean; snapshot: HealthSnapshot }): Promise<number> {
  const failures = result.ok ? 0 : agency.healthFailures + 1;
  await updateAgency(p.sql, agency.id, {
    health: p.sql.json(result.snapshot as never),
    healthOk: result.ok,
    healthCheckedAt: p.infra.now(),
    healthFailures: failures,
  });
  return failures;
}

export async function waitHealthy(p: Platform, agency: Agency, timeoutMs = p.settings.healthTimeoutMs ?? 6 * 60_000): Promise<HealthSnapshot> {
  const deadline = p.infra.now().getTime() + timeoutMs;
  for (;;) {
    const r = await probe(p, agency);
    if (r.ok) {
      await recordHealth(p, { ...agency, healthFailures: 0 }, r);
      return r.snapshot;
    }
    if (p.infra.now().getTime() >= deadline) throw new JobError(`L'instance ne répond pas (${r.snapshot.error ?? 'inconnu'}).`);
    await p.infra.sleep(10_000);
  }
}

// ---------- backups ----------

export type BackupReason = 'nightly' | 'manual' | 'pre-upgrade' | 'pre-restore' | 'final';

function stamp(d: Date): string {
  return d.toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** What goes into the bucket: encrypted when the Console has a backup key (always, outside some tests). */
function sealed(p: Platform, plain: Readable): { body: Readable; encrypted: boolean; suffix: string } {
  if (!p.backupKey) return { body: plain, encrypted: false, suffix: '' };
  const cipher = encryptStream(p.backupKey);
  // pipeline: a failing source destroys the cipher too, so the upload fails instead of waiting.
  pipeline(plain, cipher, () => undefined);
  return { body: cipher, encrypted: true, suffix: '.enc' };
}

/** A stored backup or export, readable in clear (decrypted on the fly when it was encrypted). */
export async function openStored(p: Platform, row: { objectKey: string; encrypted?: boolean | null }): Promise<Readable> {
  const raw = await p.infra.backups.get(row.objectKey);
  if (!row.encrypted) return raw;
  if (!p.backupKey) throw new JobError('Sauvegarde chiffrée, mais la Console n’a pas de clé de sauvegarde.');
  const plain = decryptStream(p.backupKey);
  pipeline(raw, plain, () => undefined);
  return plain;
}

export async function backupAgency(p: Platform, agency: Agency, reason: BackupReason): Promise<{ id: string; key: string; size: number }> {
  const state = requireState(p, agency);
  const { stream, done } = p.infra.dumper.dump(dbTarget(p, agency, state));
  const { body, encrypted, suffix } = sealed(p, stream);
  const key = `agencies/${agency.slug}/${stamp(p.infra.now())}-${reason}.dump${suffix}`;
  let size: number;
  try {
    [size] = await Promise.all([p.infra.backups.put(key, body), done]);
  } catch (err) {
    await p.infra.backups.remove(key).catch(() => undefined);
    throw new JobError(`Sauvegarde impossible : ${scrub(err instanceof Error ? err.message : String(err), state.secrets)}`);
  }
  if (size < 64 + (encrypted ? 33 : 0)) {
    await p.infra.backups.remove(key).catch(() => undefined);
    throw new JobError(`Sauvegarde vide (${size} octets) : pg_dump n'a rien produit.`);
  }
  const keepDays = reason === 'final' ? Math.max(p.settings.retentionDays, 90) : p.settings.retentionDays;
  const expires = new Date(p.infra.now().getTime() + keepDays * 86_400_000);
  const [row] = await p.sql<{ id: string }[]>`
    INSERT INTO backups (agency_id, reason, object_key, size_bytes, image_tag, expires_at, encrypted)
    VALUES (${agency.id}, ${reason}, ${key}, ${size}, ${state.deployedTag ?? agency.imageTag}, ${expires}, ${encrypted})
    RETURNING id`;
  await updateAgency(p.sql, agency.id, { lastBackupAt: p.infra.now() });
  return { id: row!.id, key, size };
}

export type BackupRow = {
  id: string;
  agencyId: string;
  reason: BackupReason;
  objectKey: string;
  sizeBytes: string;
  imageTag: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  verifiedAt: Date | null;
  verifyNote: string | null;
  removedAt: Date | null;
  encrypted: boolean;
  offsiteAt: Date | null;
  offsiteError: string | null;
};

export async function listBackups(p: Platform, agencyId: string, limit = 30): Promise<BackupRow[]> {
  return p.sql<BackupRow[]>`SELECT * FROM backups WHERE agency_id = ${agencyId} AND removed_at IS NULL ORDER BY created_at DESC LIMIT ${limit}`;
}

// ---------- data export (the instance builds the archive, the Console keeps a copy) ----------

export async function exportData(p: Platform, agency: Agency, jobId: string, step: (id: string, note?: string) => Promise<void>): Promise<{ exportRowId: string; bytes: number }> {
  const state = requireState(p, agency);
  const api = instanceApi(p, state);

  let res = await api('POST', '/api/instance/export', '{}', { 'Content-Type': 'application/json' });
  if (res.status === 409 && res.json?.export?.id) {
    // one already running: follow it
  } else if (res.status !== 202) {
    throw new JobError(`L'export n'a pas démarré : HTTP ${res.status} ${JSON.stringify(res.json)?.slice(0, 200)}`);
  }
  const exportId = String(res.json.export.id);
  await step('export-start', `export ${exportId}`);

  const deadline = p.infra.now().getTime() + 30 * 60_000;
  let downloadUrl: string | null = null;
  for (;;) {
    res = await api('GET', `/api/instance/export?id=${encodeURIComponent(exportId)}`);
    const job = res.json?.export as { state?: string; error?: string | null; tablesDone?: number; tablesTotal?: number } | undefined;
    if (res.status === 200 && job?.state === 'done' && res.json.downloadUrl) {
      downloadUrl = String(res.json.downloadUrl);
      break;
    }
    if (job?.state === 'failed') throw new JobError(`L'export a échoué sur l'instance : ${job.error ?? 'raison inconnue'}`);
    if (res.status === 404) throw new JobError("L'instance a perdu la trace de l'export (redémarrage ?). Relancez.");
    if (p.infra.now().getTime() >= deadline) throw new JobError("L'export prend plus de 30 minutes. Relancez plus tard.");
    await p.infra.sleep(5_000);
  }
  await step('export-ready');

  const { body, encrypted, suffix } = sealed(p, await p.infra.download(downloadUrl));
  const key = `exports/${agency.slug}/${stamp(p.infra.now())}-${exportId}.zip${suffix}`;
  const bytes = await p.infra.backups.put(key, body, encrypted ? 'application/octet-stream' : 'application/zip');
  const [row] = await p.sql<{ id: string }[]>`
    INSERT INTO exports (agency_id, job_id, object_key, size_bytes, encrypted) VALUES (${agency.id}, ${jobId}, ${key}, ${bytes}, ${encrypted}) RETURNING id`;
  return { exportRowId: row!.id, bytes };
}

// ---------- the Console's own database ----------

export type ConsoleBackupReason = 'nightly' | 'manual';

/** pg_dump of the Console's database (every agency's sealed state), encrypted, kept like agency backups. */
export async function backupConsole(p: Platform, reason: ConsoleBackupReason): Promise<{ id: string; size: number }> {
  const target = p.settings.consoleDb;
  if (!target) throw new JobError('Base de la Console inconnue (DATABASE_URL).');
  const { stream, done } = p.infra.dumper.dump(target);
  const { body, encrypted, suffix } = sealed(p, stream);
  const key = `console/${stamp(p.infra.now())}-${reason}.dump${suffix}`;
  let size: number;
  try {
    [size] = await Promise.all([p.infra.backups.put(key, body), done]);
  } catch (err) {
    await p.infra.backups.remove(key).catch(() => undefined);
    throw new JobError(`Sauvegarde de la Console impossible : ${(err instanceof Error ? err.message : String(err)).replace(target.password, '***')}`);
  }
  if (size < 64 + (encrypted ? 33 : 0)) {
    await p.infra.backups.remove(key).catch(() => undefined);
    throw new JobError(`Sauvegarde de la Console vide (${size} octets).`);
  }
  const expires = new Date(p.infra.now().getTime() + p.settings.retentionDays * 86_400_000);
  const [row] = await p.sql<{ id: string }[]>`
    INSERT INTO console_backups (reason, object_key, size_bytes, encrypted, expires_at)
    VALUES (${reason}, ${key}, ${size}, ${encrypted}, ${expires}) RETURNING id`;
  return { id: row!.id, size };
}

export type ConsoleBackupRow = {
  id: string;
  reason: ConsoleBackupReason;
  objectKey: string;
  sizeBytes: string;
  encrypted: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  offsiteAt: Date | null;
  offsiteError: string | null;
};

export async function listConsoleBackups(p: Platform, limit = 30): Promise<ConsoleBackupRow[]> {
  return p.sql<ConsoleBackupRow[]>`SELECT * FROM console_backups WHERE removed_at IS NULL ORDER BY created_at DESC LIMIT ${limit}`;
}
