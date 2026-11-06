// Postgres as the job queue. A claim is serialized by a transaction-scoped advisory lock,
// so two workers never run two jobs of the same agency at once.

import type { Sql } from '../db.ts';

export type JobKind =
  | 'provision'
  | 'domain'
  | 'upgrade'
  | 'backup'
  | 'restore'
  | 'restore_drill'
  | 'suspend'
  | 'resume'
  | 'license'
  | 'export'
  | 'delete';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type StepResult = 'todo' | 'running' | 'done' | 'pending' | 'skipped' | 'failed';
export type JobStep = { id: string; label: string; result: StepResult; note?: string; at?: string };

export type Job = {
  id: string;
  agencyId: string;
  kind: JobKind;
  params: Record<string, unknown>;
  status: JobStatus;
  steps: JobStep[];
  result: Record<string, unknown> | null;
  secretEnc: string | null;
  error: string | null;
  attempts: number;
  runAfter: Date;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

const CLAIM_LOCK = 727_102;

export async function enqueue(
  sql: Sql,
  input: { agencyId: string; kind: JobKind; params?: Record<string, unknown>; createdBy?: string | null; runAfter?: Date; steps?: JobStep[]; dedupe?: boolean },
): Promise<{ id: string; existing: boolean }> {
  if (input.dedupe) {
    const [open] = await sql<{ id: string }[]>`
      SELECT id FROM jobs WHERE agency_id = ${input.agencyId} AND kind = ${input.kind} AND status IN ('queued', 'running') LIMIT 1`;
    if (open) return { id: open.id, existing: true };
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO jobs (agency_id, kind, params, created_by, run_after, steps)
    VALUES (${input.agencyId}, ${input.kind}, ${sql.json((input.params ?? {}) as never)}, ${input.createdBy ?? null}, ${input.runAfter ?? new Date()}, ${sql.json((input.steps ?? []) as never)})
    RETURNING id`;
  return { id: row!.id, existing: false };
}

export async function claim(sql: Sql): Promise<Job | null> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${CLAIM_LOCK}::bigint)`;
    const [job] = await tx<Job[]>`
      UPDATE jobs SET status = 'running', started_at = now(), finished_at = NULL, error = NULL, attempts = attempts + 1
      WHERE id = (
        SELECT j.id FROM jobs j
        WHERE j.status = 'queued' AND j.run_after <= now()
          AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.agency_id = j.agency_id AND r.status = 'running')
        ORDER BY j.run_after, j.created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
      RETURNING *`;
    return job ?? null;
  });
}

export async function getJob(sql: Sql, id: string): Promise<Job | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [job] = await sql<Job[]>`SELECT * FROM jobs WHERE id = ${id}`;
  return job ?? null;
}

export async function listJobs(sql: Sql, agencyId: string, limit = 20): Promise<Job[]> {
  return sql<Job[]>`SELECT * FROM jobs WHERE agency_id = ${agencyId} ORDER BY created_at DESC LIMIT ${limit}`;
}

export async function saveSteps(sql: Sql, id: string, steps: JobStep[]): Promise<void> {
  await sql`UPDATE jobs SET steps = ${sql.json(steps as never)} WHERE id = ${id}`;
}

export async function appendLog(sql: Sql, id: string, line: string): Promise<void> {
  await sql`INSERT INTO job_logs (job_id, line) VALUES (${id}, ${line.slice(0, 4000)})`;
}

export async function jobLogs(sql: Sql, id: string, afterId = 0): Promise<{ id: string; at: Date; line: string }[]> {
  return sql`SELECT id, at, line FROM job_logs WHERE job_id = ${id} AND id > ${afterId} ORDER BY id LIMIT 500`;
}

export async function finish(sql: Sql, id: string, input: { status: 'succeeded' | 'failed'; result?: Record<string, unknown>; error?: string }): Promise<void> {
  await sql`
    UPDATE jobs SET status = ${input.status}, finished_at = now(), error = ${input.error ?? null},
      result = coalesce(${input.result ? sql.json(input.result as never) : null}, result)
    WHERE id = ${id}`;
}

/** Retry of a failed or canceled job: same id, same steps (done steps are skipped by the handlers). */
export async function requeue(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`UPDATE jobs SET status = 'queued', run_after = now(), error = NULL WHERE id = ${id} AND status IN ('failed', 'canceled') RETURNING id`;
  return rows.length > 0;
}

export async function cancel(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`UPDATE jobs SET status = 'canceled', finished_at = now() WHERE id = ${id} AND status = 'queued' RETURNING id`;
  return rows.length > 0;
}

/** At boot: a job left "running" by a crash or a redeploy is failed, so it can be retried by hand. */
export async function failInterrupted(sql: Sql): Promise<number> {
  const rows = await sql`
    UPDATE jobs SET status = 'failed', finished_at = now(), error = 'Interrompu par un redémarrage de la Console. Relancez : les étapes faites sont ignorées.'
    WHERE status = 'running' RETURNING id`;
  return rows.length;
}
