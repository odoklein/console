// Fleet upgrade as a rollout: one agency at a time, in the chosen order, stopping at the first
// failure. Each agency is an ordinary `upgrade` job (backup, migrate, deploy, health, rollback)
// carrying params.rolloutId; when it ends, the worker calls rolloutAfterJob(), which starts the next
// one. Retrying the failed agency's job and seeing it succeed resumes the rollout.

import { getAgency } from './agencies.ts';
import { openAlert, resolveAlert } from './alerts.ts';
import { plannedSteps } from './jobs/handlers.ts';
import { enqueue, type Job } from './jobs/queue.ts';
import type { Platform } from './platform.ts';

export type RolloutStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export type Rollout = {
  id: string;
  tag: string;
  agencyIds: string[];
  position: number;
  status: RolloutStatus;
  currentJobId: string | null;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};

const LIVE = new Set(['active', 'suspended']);

export async function runningRollout(p: Platform): Promise<Rollout | null> {
  const [r] = await p.sql<Rollout[]>`SELECT * FROM rollouts WHERE status = 'running' LIMIT 1`;
  return r ?? null;
}

/** Starts a rollout, or says why not (another one is running, nothing to upgrade). */
export async function startRollout(p: Platform, input: { tag: string; agencyIds: string[]; createdBy: string | null }): Promise<{ rollout: Rollout } | { error: string }> {
  if (!input.agencyIds.length) return { error: 'Aucune agence choisie.' };
  if (await runningRollout(p)) return { error: 'Une mise à jour de la flotte est déjà en cours : attendez la fin ou arrêtez-la.' };
  // A new rollout replaces one that stopped on a failure (it can no longer be resumed).
  await p.sql`UPDATE rollouts SET status = 'stopped' WHERE status = 'failed'`;
  let r: Rollout | undefined;
  try {
    [r] = await p.sql<Rollout[]>`
      INSERT INTO rollouts (tag, agency_ids, created_by) VALUES (${input.tag}, ${input.agencyIds}::uuid[], ${input.createdBy}) RETURNING *`;
  } catch {
    return { error: 'Une mise à jour de la flotte est déjà en cours : attendez la fin ou arrêtez-la.' }; // started concurrently
  }
  await startNext(p, r!);
  return { rollout: (await getRollout(p, r!.id))! };
}

export async function getRollout(p: Platform, id: string): Promise<Rollout | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await p.sql<Rollout[]>`SELECT * FROM rollouts WHERE id = ${id}`;
  return r ?? null;
}

/** Queues the upgrade of the agency at `position`, skipping agencies no longer in service; finishes when none is left. */
async function startNext(p: Platform, r: Rollout): Promise<void> {
  for (let i = r.position; i < r.agencyIds.length; i++) {
    const agency = await getAgency(p.sql, r.agencyIds[i]!);
    if (!agency || !LIVE.has(agency.status)) continue;
    const params = { tag: r.tag, rolloutId: r.id };
    const { id } = await enqueue(p.sql, { agencyId: agency.id, kind: 'upgrade', params, steps: plannedSteps('upgrade', params), createdBy: r.createdBy });
    await p.sql`UPDATE rollouts SET position = ${i}, current_job_id = ${id}, status = 'running', error = NULL WHERE id = ${r.id}`;
    return;
  }
  await p.sql`UPDATE rollouts SET position = ${r.agencyIds.length}, current_job_id = NULL, status = 'succeeded', finished_at = now() WHERE id = ${r.id}`;
  await resolveAlert(p.sql, p.infra.notify, { agencyId: null, key: 'rollout', message: `Mise à jour de la flotte vers ${r.tag} terminée` });
}

/** Called by the worker after every job: moves the rollout this job belongs to, if any. */
export async function rolloutAfterJob(p: Platform, job: Job, status: 'succeeded' | 'failed'): Promise<void> {
  const rolloutId = typeof job.params.rolloutId === 'string' ? job.params.rolloutId : null;
  if (job.kind !== 'upgrade' || !rolloutId) return;
  const r = await getRollout(p, rolloutId);
  // Only the job the rollout is waiting for moves it (an old job retried later does not).
  if (!r || r.currentJobId !== job.id || r.status === 'stopped' || r.status === 'succeeded') return;
  if (status === 'succeeded') {
    await startNext(p, { ...r, position: r.position + 1 });
    return;
  }
  const agency = await getAgency(p.sql, job.agencyId);
  const [row] = await p.sql<{ error: string | null }[]>`SELECT error FROM jobs WHERE id = ${job.id}`;
  const error = `${agency?.name ?? 'Une agence'} : ${row?.error ?? 'échec'}`;
  await p.sql`UPDATE rollouts SET status = 'failed', error = ${error.slice(0, 2000)}, finished_at = now() WHERE id = ${r.id}`;
  await openAlert(p.sql, p.infra.notify, {
    agencyId: null,
    kind: 'job',
    key: 'rollout',
    message: `Mise à jour de la flotte vers ${r.tag} arrêtée à ${agency?.name ?? 'une agence'} (${r.position + 1}/${r.agencyIds.length}) : les suivantes n’ont pas été touchées. Relancez l’opération de cette agence pour reprendre.`,
  });
}

/** No agency after the current one is started; the current upgrade (if running) finishes normally. */
export async function stopRollout(p: Platform, id: string): Promise<boolean> {
  const rows = await p.sql`UPDATE rollouts SET status = 'stopped', finished_at = now() WHERE id = ${id} AND status IN ('running', 'failed') RETURNING id`;
  if (rows.length) await resolveAlert(p.sql, p.infra.notify, { agencyId: null, key: 'rollout' });
  return rows.length > 0;
}

export type RolloutItem = { agencyId: string; name: string; slug: string; state: 'todo' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'skipped'; jobId: string | null };

/** The rollout to show on the fleet page: the running one, else the last one if it ended less than 24 h ago. */
export async function rolloutForFleet(p: Platform, now: Date): Promise<{ rollout: Rollout; items: RolloutItem[] } | null> {
  const [r] = await p.sql<Rollout[]>`
    SELECT * FROM rollouts WHERE status = 'running' OR finished_at > ${new Date(now.getTime() - 86_400_000)}
    ORDER BY (status = 'running') DESC, created_at DESC LIMIT 1`;
  if (!r) return null;
  const jobs = await p.sql<{ id: string; agencyId: string; status: Job['status'] }[]>`
    SELECT DISTINCT ON (agency_id) id, agency_id, status FROM jobs WHERE params->>'rolloutId' = ${r.id} ORDER BY agency_id, created_at DESC`;
  const byAgency = new Map(jobs.map((j) => [j.agencyId, j]));
  const agencies = await p.sql<{ id: string; name: string; slug: string }[]>`SELECT id, name, slug FROM agencies WHERE id = ANY(${r.agencyIds}::uuid[])`;
  const names = new Map(agencies.map((a) => [a.id, a]));
  const items = r.agencyIds.map((agencyId, i): RolloutItem => {
    const j = byAgency.get(agencyId);
    const a = names.get(agencyId);
    const state: RolloutItem['state'] = j ? j.status : i < r.position ? 'skipped' : 'todo';
    return { agencyId, name: a?.name ?? '?', slug: a?.slug ?? '', state, jobId: j?.id ?? null };
  });
  return { rollout: r, items };
}
