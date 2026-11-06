// Fleet rollouts as a state machine, over a real Postgres (PGlite): order, agencies no longer in
// service skipped, stop on failure, resume after a successful retry, stop by hand. The upgrades
// themselves are not run here (operations.test.ts does that end to end).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createAgency, updateAgency } from '../src/agencies.ts';
import { createSealer } from '../src/crypto.ts';
import { createDb, type Sql } from '../src/db.ts';
import { getJob, type Job } from '../src/jobs/queue.ts';
import { setLogLevel } from '../src/log.ts';
import { migrate } from '../src/migrate.ts';
import type { Platform } from '../src/platform.ts';
import { getRollout, rolloutAfterJob, rolloutForFleet, startRollout, stopRollout } from '../src/rollouts.ts';
import { makeFleet } from './fakes.ts';

const PORT = 54359;
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let p: Platform;
const ids: Record<string, string> = {};

before(async () => {
  setLogLevel('error');
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  sql = createDb(`postgres://postgres@127.0.0.1:${PORT}/postgres`, 1);
  await migrate(sql);
  p = { sql, infra: makeFleet().infra, sealer: createSealer('ef'.repeat(32)), settings: {} as Platform['settings'] };
  for (const slug of ['alpha', 'bravo', 'charlie']) {
    const a = await createAgency(sql, {
      config: { slug, name: slug[0]!.toUpperCase() + slug.slice(1), manager: { email: `m@${slug}.fr`, name: 'M' } },
      primaryHost: `${slug}.crm-agence.fr`,
      imageTag: 'v1',
      logos: [],
      createdBy: null,
    });
    await updateAgency(sql, a.id, { status: 'active' });
    ids[slug] = a.id;
  }
});

after(async () => {
  await sql.end();
  await server.stop();
  await db.close();
});

async function current(id: string): Promise<Job> {
  const r = (await getRollout(p, id))!;
  return (await getJob(sql, r.currentJobId!))!;
}

const openRolloutAlerts = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM alerts WHERE key = 'rollout' AND resolved_at IS NULL`)[0]!.n;

test('order, stop on failure, resume after a successful retry, skip an agency out of service, finish', async () => {
  // charlie first (the route puts the "commencer par" agency at the front), then alpha, bravo.
  const started = await startRollout(p, { tag: 'v2', agencyIds: [ids.charlie!, ids.alpha!, ids.bravo!], createdBy: null });
  assert.ok('rollout' in started);
  const id = started.rollout.id;
  let job = await current(id);
  assert.equal(job.agencyId, ids.charlie);
  assert.deepEqual(job.params, { tag: 'v2', rolloutId: id });
  assert.equal((await sql`SELECT count(*)::int AS n FROM jobs`)[0]!.n, 1, 'one agency at a time');

  await rolloutAfterJob(p, job, 'succeeded');
  job = await current(id);
  assert.equal(job.agencyId, ids.alpha);

  // alpha fails: the rollout stops, bravo is not touched.
  await sql`UPDATE jobs SET status = 'failed', error = ${"La version v2 n'a pas démarré"} WHERE id = ${job.id}`;
  await rolloutAfterJob(p, job, 'failed');
  let r = (await getRollout(p, id))!;
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /Alpha : La version v2/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE agency_id = ${ids.bravo!}`)[0]!.n, 0);
  assert.equal(await openRolloutAlerts(), 1);

  // Another job finishing does not move it.
  await rolloutAfterJob(p, { ...job, id: '00000000-0000-0000-0000-000000000000' }, 'succeeded');
  assert.equal((await getRollout(p, id))!.status, 'failed');

  // bravo leaves service meanwhile; alpha's retry succeeds: the rollout resumes, skips bravo, ends.
  await updateAgency(sql, ids.bravo!, { status: 'deleted' });
  await sql`UPDATE jobs SET status = 'succeeded', error = NULL WHERE id = ${job.id}`;
  await rolloutAfterJob(p, job, 'succeeded');
  r = (await getRollout(p, id))!;
  assert.equal(r.status, 'succeeded');
  const view = (await rolloutForFleet(p, new Date()))!;
  assert.deepEqual(
    view.items.map((i) => [i.slug, i.state]),
    [['charlie', 'queued'], ['alpha', 'succeeded'], ['bravo', 'skipped']],
  );
  assert.equal(await openRolloutAlerts(), 0, 'alert resolved at the end');
});

test('a stopped rollout starts nothing more, and a new one may start', async () => {
  await updateAgency(sql, ids.bravo!, { status: 'active' });
  const started = await startRollout(p, { tag: 'v3', agencyIds: [ids.alpha!, ids.bravo!], createdBy: null });
  assert.ok('rollout' in started);
  assert.ok('error' in (await startRollout(p, { tag: 'v4', agencyIds: [ids.alpha!], createdBy: null })), 'one running rollout at a time');
  const job = await current(started.rollout.id);
  assert.ok(await stopRollout(p, started.rollout.id));
  await rolloutAfterJob(p, job, 'succeeded');
  assert.equal((await getRollout(p, started.rollout.id))!.status, 'stopped');
  assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE params->>'rolloutId' = ${started.rollout.id}`)[0]!.n, 1);
  assert.ok('rollout' in (await startRollout(p, { tag: 'v3', agencyIds: [ids.bravo!], createdBy: null })));
});
