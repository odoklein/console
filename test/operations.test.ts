// End to end over a real Postgres (PGlite, in-process) and a fake fleet:
// wizard row -> provision job -> upgrade (and rollback) -> backups, restore, drill ->
// suspend/resume -> scheduler (health, cron, nightly) -> delete.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createAgency, getAgency, readState } from '../src/agencies.ts';
import { deriveBackupKey } from '../src/backup-crypto.ts';
import { createSealer } from '../src/crypto.ts';
import { createDb, type Sql } from '../src/db.ts';
import { plannedSteps } from '../src/jobs/handlers.ts';
import { openStored } from '../src/jobs/ops.ts';
import { enqueue, getJob, requeue, type JobKind } from '../src/jobs/queue.ts';
import { runOnce } from '../src/jobs/worker.ts';
import { setLogLevel } from '../src/log.ts';
import { migrate } from '../src/migrate.ts';
import type { Platform } from '../src/platform.ts';
import { getRollout, startRollout } from '../src/rollouts.ts';
import { backupPass, consoleBackupInBackground, cronPass, domainPass, healthPass, offsitePass } from '../src/scheduler.ts';
import { makeFleet } from './fakes.ts';

const PORT = 54339;
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let fleet: ReturnType<typeof makeFleet>;
let p: Platform;
let agencyId: string;

before(async () => {
  setLogLevel('error');
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  sql = createDb(`postgres://postgres@127.0.0.1:${PORT}/postgres`, 1);
  assert.deepEqual(await migrate(sql), ['0001_init.sql', '0002_control.sql', '0003_releases.sql']);
  fleet = makeFleet();
  p = {
    sql,
    infra: fleet.infra,
    sealer: createSealer('ab'.repeat(32)),
    settings: {
      platformDomain: 'crm-agence.fr',
      pg: { host: 'pg', port: 5432 },
      pgFromConsole: { host: 'pg.internal', port: 5432 },
      minio: { endpoint: 'https://minio.crm-agence.fr', accessKeyId: 'admin', secretAccessKey: 'adminsecret' },
      shared: { SYSTEM_SMTP_HOST: 'smtp.example.com' },
      imageRepo: 'ghcr.io/odoklein/captainprospect-crm',
      defaultTag: 'v1',
      dokployProject: 'agencies',
      retentionDays: 30,
      backupHourUtc: 2,
      drillDay: 1,
      healthFailuresBeforeAlert: 3,
      centralCron: true,
      consoleUrl: 'https://console.example',
      healthTimeoutMs: 30_000,
      consoleDb: { host: 'console-pg', port: 5432, database: 'console', user: 'console', password: 'console-db-secret-123' },
    },
    backupKey: deriveBackupKey('ab'.repeat(32)),
  };
});

after(async () => {
  await sql.end();
  await server.stop();
  await db.close();
});

async function run(kind: JobKind, params: Record<string, unknown> = {}, createdBy: string | null = null) {
  const { id } = await enqueue(sql, { agencyId, kind, params, steps: plannedSteps(kind, params), createdBy });
  while (await runOnce(p));
  return (await getJob(sql, id))!;
}

const agency = async () => (await getAgency(sql, agencyId))!;

test('provision: the wizard row becomes a running agency, secrets sealed, invite emailed', async () => {
  const a = await createAgency(sql, {
    config: {
      slug: 'agence-nord',
      name: 'Agence Nord',
      manager: { email: 'chef@agence-nord.fr', name: 'Chef Nord' },
      brand: { primaryColor: '#123456', accentColor: '#E4572E' },
      license: { plan: 'equipe', seatLimit: 10 },
      extra: { pack: 'equipe', billing: { email: 'compta@agence-nord.fr' } },
    },
    primaryHost: 'agence-nord.crm-agence.fr',
    imageTag: 'v1',
    logos: [{ slot: 'full', filename: 'logo.png', contentType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }],
    createdBy: null,
  });
  agencyId = a.id;
  const job = await run('provision', { tag: 'v1' }, null);

  assert.equal(job.status, 'succeeded', job.error ?? '');
  assert.ok(job.steps.every((s) => s.result === 'done'), JSON.stringify(job.steps));
  const g = await agency();
  assert.equal(g.status, 'active');
  assert.equal(g.imageTag, 'v1');
  assert.deepEqual(g.domains, ['agence-nord.crm-agence.fr']);
  assert.ok(fleet.databases.has('db_agence_nord') && fleet.roles.has('agency_agence_nord'));
  assert.ok(fleet.routes.get('agence-nord')?.includes('agence-nord.crm-agence.fr'));
  assert.equal(fleet.instance.badSignatures, 0);

  // Secrets: only sealed in the database, never in the logs.
  const raw = await sql<{ stateEnc: string }[]>`SELECT state_enc FROM agencies WHERE id = ${agencyId}`;
  const state = readState(p.sealer, g)!;
  assert.ok(!raw[0]!.stateEnc.includes(state.secrets.dbPassword));
  const logs = (await sql<{ line: string }[]>`SELECT line FROM job_logs`).map((r) => r.line).join('\n');
  for (const s of Object.values(state.secrets)) assert.ok(!logs.includes(s), 'secret in job logs');

  // Invite: emailed, and kept sealed on the job (not in the logs).
  assert.deepEqual(fleet.invites.map((i) => i.to), ['chef@agence-nord.fr']);
  assert.ok(!logs.includes('TOKEN123'));
  assert.equal(JSON.parse(p.sealer.open(job.secretEnc!)).inviteUrl.includes('TOKEN123'), true);
  assert.equal(job.result?.inviteEmailed, true);
});

test('a retry of a finished provision changes nothing on the servers', async () => {
  fleet.calls.length = 0;
  const job = await run('provision', { tag: 'v1' });
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(fleet.calls, []);
});

test('upgrade: backup first, then migrate with the new image and redeploy', async () => {
  fleet.calls.length = 0;
  const job = await run('upgrade', { tag: 'v2' }, null);
  assert.equal(job.status, 'succeeded', job.error ?? '');
  assert.equal((await agency()).imageTag, 'v2');
  assert.ok(fleet.calls.indexOf('db.migrate:v2') < fleet.calls.indexOf('dokploy.deploy:v2'));
  const [b] = await sql`SELECT reason FROM backups WHERE agency_id = ${agencyId} ORDER BY created_at DESC LIMIT 1`;
  assert.equal(b!.reason, 'pre-upgrade');
  assert.deepEqual(job.steps.map((s) => s.result), ['done', 'done', 'done', 'done', 'done', 'done']);
});

test('upgrade: a version that does not come up is rolled back automatically', async () => {
  fleet.instance.badTags.add('v3');
  fleet.calls.length = 0;
  const job = await run('upgrade', { tag: 'v3' }, null);
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /v3 n'a pas démarré.*revenue en v2/);
  assert.equal(job.result?.rolledBack, true);
  assert.equal(job.steps.find((s) => s.id === 'rollback')?.result, 'done');
  assert.ok(fleet.calls.includes('dokploy.deploy:v3') && fleet.calls.at(-1) === 'dokploy.deploy:v2');
  assert.equal((await agency()).imageTag, 'v2');
  fleet.instance.badTags.clear();
});

test('fleet rollout: stops on a failed agency, resumes when its upgrade is retried and succeeds', async () => {
  fleet.instance.badTags.add('v4');
  const started = await startRollout(p, { tag: 'v4', agencyIds: [agencyId], createdBy: null });
  assert.ok('rollout' in started);
  const id = started.rollout.id;
  assert.ok('error' in (await startRollout(p, { tag: 'v5', agencyIds: [agencyId], createdBy: null })), 'one rollout at a time');
  while (await runOnce(p));
  let r = (await getRollout(p, id))!;
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /Agence Nord/);
  assert.ok(fleet.alerts.some((a) => /Mise à jour de la flotte vers v4 arrêtée/.test(a)));
  assert.equal((await agency()).imageTag, 'v2', 'rolled back');

  fleet.instance.badTags.clear();
  assert.ok(await requeue(sql, r.currentJobId!));
  while (await runOnce(p));
  r = (await getRollout(p, id))!;
  assert.equal(r.status, 'succeeded', r.error ?? '');
  assert.equal((await agency()).imageTag, 'v4');
  assert.equal((await sql`SELECT count(*)::int AS n FROM alerts WHERE key = 'rollout' AND resolved_at IS NULL`)[0]!.n, 0, 'alert resolved');
});

test('backup, restore (in place, behind a safety backup) and the monthly drill', async () => {
  const backup = await run('backup', { reason: 'manual' });
  assert.equal(backup.status, 'succeeded', backup.error ?? '');
  const backupId = backup.result!.backupId as string;
  assert.equal((await agency()).storageBytes, '1234');
  const [stored] = await sql<{ objectKey: string; encrypted: boolean }[]>`SELECT object_key, encrypted FROM backups WHERE id = ${backupId}`;
  assert.equal(stored!.encrypted, true);
  assert.match(stored!.objectKey, /\.dump\.enc$/);
  const raw = fleet.objects.get(stored!.objectKey)!;
  assert.equal(raw.subarray(0, 4).toString(), 'CPBK');
  assert.ok(!raw.includes('PGDMP'), 'nothing readable in the bucket');

  // Damage the database, then restore the backup taken above.
  fleet.databases.get('db_agence_nord')!.content = 'broken';
  fleet.calls.length = 0;
  const restore = await run('restore', { backupId });
  assert.equal(restore.status, 'succeeded', restore.error ?? '');
  assert.match(fleet.databases.get('db_agence_nord')!.content, /schema/);
  assert.deepEqual(fleet.calls.filter((c) => /stop|start|restore/.test(c)), ['dokploy.stop', 'restore:db_agence_nord', 'dokploy.start']);
  const reasons = (await sql<{ reason: string }[]>`SELECT reason FROM backups WHERE agency_id = ${agencyId}`).map((r) => r.reason);
  assert.ok(reasons.includes('pre-restore'), 'the state before the restore was saved');

  const drill = await run('restore_drill', { backupId });
  assert.equal(drill.status, 'succeeded', drill.error ?? '');
  const [b] = await sql<{ verifiedAt: Date | null; verifyNote: string }[]>`SELECT verified_at, verify_note FROM backups WHERE id = ${backupId}`;
  assert.ok(b!.verifiedAt);
  assert.match(b!.verifyNote, /42 migrations, 1 utilisateurs/);
  assert.ok(!fleet.databases.has('db_agence_nord_drill'), 'scratch database dropped');
});

test('suspend and resume go through the license API', async () => {
  assert.equal((await run('suspend', { reason: 'Impayé' })).status, 'succeeded');
  assert.equal(fleet.instance.license.status, 'SUSPENDED');
  assert.equal((await agency()).status, 'suspended');
  assert.equal((await run('resume')).status, 'succeeded');
  assert.equal(fleet.instance.license.status, 'ACTIVE');
  assert.equal((await agency()).status, 'active');
  assert.equal((await run('license', { plan: 'agence', seatLimit: 25, pack: 'agence' })).status, 'succeeded');
  assert.equal((await agency()).config.license?.seatLimit, 25);
});

test('scheduler: health alerts after 3 failures and resolves; central cron runs on schedule', async () => {
  fleet.alerts.length = 0;
  fleet.instance.down = true;
  for (let i = 0; i < 3; i++) {
    fleet.advance(60_000);
    await healthPass(p, fleet.infra.now());
  }
  assert.equal((await agency()).healthFailures, 3);
  assert.equal(fleet.alerts.length, 1);
  assert.match(fleet.alerts[0]!, /Agence Nord : Instance hors ligne/);
  fleet.advance(60_000);
  await healthPass(p, fleet.infra.now());
  assert.equal(fleet.alerts.length, 1, 'one alert, not one per probe');

  fleet.instance.down = false;
  fleet.advance(60_000);
  await healthPass(p, fleet.infra.now());
  assert.equal((await agency()).healthOk, true);
  assert.match(fleet.alerts.at(-1)!, /de nouveau en ligne/);

  fleet.setTime('2026-10-27T04:00:10Z');
  await Promise.all(await cronPass(p, fleet.infra.now()));
  assert.deepEqual(fleet.instance.cronCalls.sort(), ['exclusion-sweep', 'messaging-outbox']);
  await Promise.all(await cronPass(p, new Date(fleet.infra.now().getTime() + 20_000)));
  assert.equal(fleet.instance.cronCalls.length, 2, 'the same minute is dispatched once');

  fleet.instance.cronFails.add('messaging-outbox');
  for (let i = 1; i <= 3; i++) await Promise.all(await cronPass(p, new Date(Date.parse('2026-10-27T04:00:00Z') + i * 60_000)));
  const open = await sql`SELECT key FROM alerts WHERE resolved_at IS NULL AND key LIKE 'cron:%'`;
  assert.deepEqual(open.map((r) => r.key), ['cron:messaging-outbox']);
  fleet.instance.cronFails.clear();
});

test('off-site: encrypted backups are copied, a copy missing after 6 h opens an alert, then it catches up', async () => {
  fleet.alerts.length = 0;
  fleet.offsiteState.down = true;
  // created_at comes from the database clock (real time), not the fake one.
  await offsitePass(p, new Date(Date.now() + 7 * 3_600_000));
  assert.ok(fleet.alerts.some((a) => /Copie hors site en retard/.test(a)));
  const [failing] = await sql`SELECT count(*)::int AS n FROM backups WHERE offsite_error IS NOT NULL`;
  assert.ok(failing!.n > 0);

  fleet.offsiteState.down = false;
  for (let i = 0; i < 10; i++) await offsitePass(p, fleet.infra.now());
  const pending = await sql`SELECT object_key FROM backups WHERE encrypted AND offsite_at IS NULL AND removed_at IS NULL`;
  assert.equal(pending.length, 0);
  const copied = await sql<{ objectKey: string }[]>`SELECT object_key FROM backups WHERE offsite_at IS NOT NULL`;
  for (const b of copied) assert.ok(fleet.offsiteObjects.get(b.objectKey)?.equals(fleet.objects.get(b.objectKey)!), 'same bytes off-site');
  assert.match(fleet.alerts.at(-1)!, /Copie hors site de nouveau à jour/);
});

test('the Console backs up its own database, encrypted, and the copy decrypts', async () => {
  fleet.databases.set('console', { owner: 'console', content: 'operators agencies' });
  await consoleBackupInBackground(p, 'manual');
  const [b] = await sql<{ objectKey: string; encrypted: boolean; reason: string }[]>`SELECT object_key, encrypted, reason FROM console_backups`;
  assert.equal(b!.reason, 'manual');
  assert.equal(b!.encrypted, true);
  let plain = '';
  for await (const c of await openStored(p, b!)) plain += c.toString();
  assert.match(plain, /^PGDMP\|console\|operators agencies\|/);
  await offsitePass(p, fleet.infra.now());
  assert.ok(fleet.offsiteObjects.has(b!.objectKey), 'copied off-site too');
});

test('scheduler: nightly backups once per night, retention keeps the newest, pending domains re-checked', async () => {
  fleet.setTime('2026-10-28T02:00:05Z');
  await backupPass(p, fleet.infra.now());
  await backupPass(p, new Date(fleet.infra.now().getTime() + 30_000));
  const queued = await sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'backup' AND status = 'queued'`;
  assert.equal(queued[0]!.n, 1);
  while (await runOnce(p));
  await new Promise((r) => setTimeout(r, 50)); // the Console's own nightly dump runs beside the jobs
  assert.equal((await sql`SELECT count(*)::int AS n FROM console_backups WHERE reason = 'nightly'`)[0]!.n, 1);

  // Everything expires 30 days later: all removed but the newest.
  fleet.setTime('2026-12-15T10:00:00Z');
  await backupPass(p, fleet.infra.now());
  const left = await sql`SELECT reason FROM backups WHERE agency_id = ${agencyId} AND removed_at IS NULL`;
  assert.equal(left.length, 1);
  assert.equal(left[0]!.reason, 'nightly');
  const consoleLeft = await sql<{ reason: string }[]>`SELECT reason FROM console_backups WHERE removed_at IS NULL`;
  assert.deepEqual(consoleLeft.map((r) => r.reason), ['nightly'], 'the Console keeps its newest backup too');
  const removedOffsite = await sql<{ objectKey: string }[]>`SELECT object_key FROM backups WHERE removed_at IS NOT NULL AND offsite_at IS NOT NULL`;
  assert.ok(removedOffsite.length > 0 && removedOffsite.every((b) => !fleet.offsiteObjects.has(b.objectKey)), 'expired copies removed off-site too');

  await sql`UPDATE agencies SET domain_pending = true WHERE id = ${agencyId}`;
  await domainPass(p, fleet.infra.now());
  await domainPass(p, fleet.infra.now());
  const domainJobs = await sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'domain' AND status = 'queued'`;
  assert.equal(domainJobs[0]!.n, 1);
  await sql`UPDATE agencies SET domain_pending = false WHERE id = ${agencyId}`;
  await sql`UPDATE jobs SET status = 'canceled' WHERE kind = 'domain' AND status = 'queued'`;
});

test('delete: refused without the typed confirmation, then export, final backup and every resource removed', async () => {
  const refused = await run('delete', { confirm: 'nope' });
  assert.equal(refused.status, 'failed');
  assert.equal((await agency()).status, 'active');

  fleet.calls.length = 0;
  const job = await run('delete', { confirm: 'agence-nord' });
  assert.equal(job.status, 'succeeded', job.error ?? '');
  const g = await agency();
  assert.equal(g.status, 'deleted');
  assert.equal(g.stateEnc, null);
  assert.ok(!fleet.databases.has('db_agence_nord') && !fleet.roles.has('agency_agence_nord'));
  assert.ok(!fleet.buckets.has('agence-nord'));
  assert.equal(fleet.apps.size, 0);
  assert.ok(!fleet.routes.has('agence-nord'));
  assert.ok(fleet.calls.some((c) => c.startsWith('storage.removeKey:agency-agence-n-')));

  // The export archive and the final backup survive the agency.
  const [exp] = await sql<{ objectKey: string; encrypted: boolean }[]>`SELECT object_key, encrypted FROM exports WHERE agency_id = ${agencyId}`;
  assert.equal(fleet.objects.get(exp!.objectKey)?.subarray(0, 4).toString(), 'CPBK', 'the export is encrypted');
  let zip = '';
  for await (const c of await openStored(p, exp!)) zip += c.toString();
  assert.ok(zip.startsWith('ZIP('));
  const [fin] = await sql`SELECT reason, expires_at FROM backups WHERE agency_id = ${agencyId} AND reason = 'final'`;
  assert.ok(fin && fin.expiresAt.getTime() - fleet.infra.now().getTime() > 80 * 86_400_000, "final backup kept 90 days");
  assert.ok(fleet.calls.indexOf('pg.dropDatabase:db_agence_nord') > fleet.calls.findIndex((c) => c.startsWith('license:')), 'suspended before anything is removed');
});
