// « Nouveautés »: drafting notes from commits, form validation, Paris time, and the delivery
// lifecycle against the fake fleet (publish, version-gated releases, old CRMs, retries, retraction,
// reading figures).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createAgency, getAgency } from '../src/agencies.ts';
import { deriveBackupKey } from '../src/backup-crypto.ts';
import { createSealer } from '../src/crypto.ts';
import { createDb, type Sql } from '../src/db.ts';
import { parisLocal } from '../src/http/app.ts';
import { plannedSteps } from '../src/jobs/handlers.ts';
import { enqueue, getJob, type JobKind } from '../src/jobs/queue.ts';
import { runOnce } from '../src/jobs/worker.ts';
import { setLogLevel } from '../src/log.ts';
import { migrate } from '../src/migrate.ts';
import {
  announcementProblem, cleanNotes, createAnnouncement, createRelease, deliveriesOf, deliveryPass, draftNotes, getRelease,
  publishRelease, reachByItem, retract, saveRelease, statsPass, type AnnouncementInput,
} from '../src/news.ts';
import type { Platform } from '../src/platform.ts';
import { makeFleet } from './fakes.ts';

const commit = (message: string, i = 0) => ({ sha: `abc${i}def0123`, message, author: 'Odo', date: '2026-11-16T10:00:00Z', url: `https://x/${i}` });

test('draft notes: conventional prefixes, plain verbs, noise left out', () => {
  const { notes, skipped } = draftNotes([
    commit('feat(sdr): AI assistant panel in the SDR workspace\n\nA docked assistant…\n\nCo-Authored-By: X'),
    commit('fix: recording playback when the provider is down (#42)'),
    commit('refactor(rdv): faster list'),
    commit('chore: bump deps'),
    commit('docs: readme'),
    commit("Merge branch 'main'"),
    commit('Connect Onoff Business telephony (per-agency webhook)'),
    commit('Prevent double booking.'),
    commit('Rework tutorial motion'),
  ]);
  assert.equal(skipped, 3);
  assert.deepEqual(notes.map((n) => [n.type, n.title, n.module]), [
    ['new', 'AI assistant panel in the SDR workspace', 'Sdr'],
    ['fixed', 'Recording playback when the provider is down', null],
    ['improved', 'Faster list', 'Rdv'],
    ['new', 'Connect Onoff Business telephony (per-agency webhook)', null],
    ['fixed', 'Prevent double booking', null],
    ['improved', 'Rework tutorial motion', null],
  ]);
  assert.ok(notes.every((n) => n.body === null), 'developer prose never lands in a note by itself');
});

test('notes from the editor: empty rows dropped, problems named', () => {
  assert.deepEqual(cleanNotes([{ type: 'new', title: ' A ', body: '', module: '' }, { type: 'fixed', title: '', body: '', module: '' }]), {
    ok: true, notes: [{ type: 'new', title: 'A', body: null, module: null }],
  });
  assert.equal(cleanNotes([{ type: 'oops', title: 'A' }]).ok, false);
  assert.match((cleanNotes([{ type: 'new', title: '', body: 'only a body' }]) as { error: string }).error, /titre manque/);
  assert.match((cleanNotes([{ type: 'new', title: 'x'.repeat(141) }]) as { error: string }).error, /trop long/);
});

test('Paris wall clock, winter and summer time', () => {
  assert.equal((parisLocal('2026-11-18T21:00') as Date).toISOString(), '2026-11-18T20:00:00.000Z');
  assert.equal((parisLocal('2026-07-14T21:00') as Date).toISOString(), '2026-07-14T19:00:00.000Z');
  assert.equal(parisLocal(''), null);
  assert.equal(parisLocal('18/11/2026'), 'invalid');
});

test('announcement form rules', () => {
  const base: AnnouncementInput = { kind: 'maintenance', title: 'Maintenance', body: '', severity: 'warning', audience: 'everyone', startsAt: null, endsAt: null, ctaLabel: null, ctaUrl: null, target: { all: true } };
  assert.equal(announcementProblem(base), null);
  const soon = new Date(Date.now() + 3_600_000);
  assert.match(announcementProblem({ ...base, startsAt: soon, endsAt: new Date(soon.getTime() - 60_000) })!, /fin doit suivre/);
  assert.match(announcementProblem({ ...base, endsAt: new Date(Date.now() - 60_000) })!, /déjà terminée/);
  assert.match(announcementProblem({ ...base, ctaLabel: 'Voir' })!, /libellé et d’un lien/);
  assert.match(announcementProblem({ ...base, ctaLabel: 'Voir', ctaUrl: 'javascript:alert(1)' })!, /https/);
  assert.equal(announcementProblem({ ...base, ctaLabel: 'Voir', ctaUrl: '/manager/billing' }), null);
  assert.match(announcementProblem({ ...base, target: { packs: [] } })!, /au moins une offre/);
});

// ---------- delivery lifecycle ----------

const PORT = 54353;
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let p: Platform;
let fleet: ReturnType<typeof makeFleet>;
let agencyId: string;

before(async () => {
  setLogLevel('error');
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  sql = createDb(`postgres://postgres@127.0.0.1:${PORT}/postgres`, 1);
  await migrate(sql);
  fleet = makeFleet();
  fleet.github.commits.set('v1...v2', [commit('feat: video tutorials', 1), commit('fix: playback', 2), commit('chore: x', 3)]);
  p = {
    sql,
    infra: fleet.infra,
    sealer: createSealer('ef'.repeat(32)),
    settings: {
      platformDomain: 'crm-agence.fr', pg: { host: 'pg', port: 5432 }, pgFromConsole: { host: 'pg', port: 5432 },
      minio: { endpoint: 'https://minio', accessKeyId: 'a', secretAccessKey: 'b' }, shared: {}, imageRepo: 'ghcr.io/x/crm', defaultTag: 'v1',
      dokployProject: 'agencies', retentionDays: 30, backupHourUtc: 2, drillDay: 1, healthFailuresBeforeAlert: 3, centralCron: true,
      consoleUrl: 'https://console.example', healthTimeoutMs: 30_000,
    },
    backupKey: deriveBackupKey('ef'.repeat(32)),
  };
  const a = await createAgency(sql, {
    config: { slug: 'agence-nord', name: 'Agence Nord', manager: { email: 'chef@agence-nord.fr', name: 'Chef' }, license: { plan: 'equipe', seatLimit: 10 }, extra: { pack: 'equipe' } } as never,
    primaryHost: 'agence-nord.crm-agence.fr', imageTag: 'v1', logos: [], createdBy: null,
  });
  agencyId = a.id;
  const job = await run('provision', { tag: 'v1' });
  assert.equal(job.status, 'succeeded', job.error ?? '');
});

after(async () => {
  await sql.end();
  await server.stop();
  await db.close();
});

async function run(kind: JobKind, params: Record<string, unknown> = {}) {
  const { id } = await enqueue(sql, { agencyId, kind, params, steps: plannedSteps(kind, params), createdBy: null });
  while (await runOnce(p));
  return (await getJob(sql, id))!;
}

/** Runs the delivery pass as if time had moved on past every backoff. */
const later = () => deliveryPass(p, new Date(Date.now() + 2 * 24 * 3_600_000));
const status = async (kind: 'release' | 'announcement', id: string) => (await deliveriesOf(sql, kind, id)).map((d) => d.status);

test('a release is drafted from the commits, and reaches the agency running its version', async () => {
  const r1 = await createRelease(p, { tag: 'v1', fromTag: '', operatorId: null as never, now: new Date() });
  assert.ok(r1.ok);
  const publish1 = await publishRelease(sql, r1.id);
  assert.equal(publish1.ok, false, 'no notes and no summary: nothing to publish');
  await saveRelease(sql, r1.id, { title: 'Première version', summary: 'Bienvenue.', audience: 'managers', target: 'tag', notes: [] });
  assert.deepEqual(await publishRelease(sql, r1.id), { ok: true, queued: 1 });
  await deliveryPass(p, new Date());
  assert.deepEqual(await status('release', r1.id), ['delivered']);
  const sent = fleet.instance.changelog.get('release:v1');
  assert.equal(sent.kind, 'release');
  assert.equal(sent.summary, 'Bienvenue.');
  assert.equal(fleet.instance.badSignatures, 0, 'every call is signed with the agency secret');

  const r2 = await createRelease(p, { tag: 'v2', fromTag: 'v1', operatorId: null as never, now: new Date() });
  assert.ok(r2.ok && r2.drafted === 2 && r2.skipped === 1);
  const rel = (await getRelease(sql, r2.id))!;
  assert.deepEqual(rel.notes.map((n) => n.type), ['new', 'fixed']);
  assert.equal(rel.commits.length, 3);
  assert.equal((await createRelease(p, { tag: 'v2', fromTag: 'v1', operatorId: null as never, now: new Date() })).ok, false, 'one draft per version');
  assert.deepEqual(await publishRelease(sql, r2.id), { ok: true, queued: 0 }, 'nobody runs v2 yet');

  const up = await run('upgrade', { tag: 'v2' });
  assert.equal(up.status, 'succeeded', up.error ?? '');
  assert.equal((await getAgency(sql, agencyId))!.imageTag, 'v2');
  await deliveryPass(p, new Date());
  assert.deepEqual(await status('release', r2.id), ['delivered'], 'the upgrade queued the notes of the new version');
  assert.equal(fleet.instance.changelog.get('release:v2').items.length, 2);
});

test('an old CRM waits for its upgrade; failures retry with a reason; retraction removes it', async () => {
  fleet.instance.noChangelog = true;
  const a = await createAnnouncement(sql, { kind: 'maintenance', title: 'Maintenance mardi', body: 'Quinze minutes.', severity: 'warning', audience: 'everyone', startsAt: null, endsAt: null, ctaLabel: null, ctaUrl: null, target: { all: true } }, null as never);
  assert.equal(a.queued, 1);
  await deliveryPass(p, new Date());
  let [d] = await deliveriesOf(sql, 'announcement', a.id);
  assert.equal(d!.status, 'unsupported');
  assert.match(d!.lastError!, /trop ancienne/);
  await later();
  assert.deepEqual(await status('announcement', a.id), ['unsupported'], 'not retried until the agency is upgraded');

  fleet.instance.noChangelog = false;
  const up = await run('upgrade', { tag: 'v3' });
  assert.equal(up.status, 'succeeded', up.error ?? '');
  fleet.instance.changelogFailOnce = 422;
  await deliveryPass(p, new Date());
  [d] = await deliveriesOf(sql, 'announcement', a.id);
  assert.equal(d!.status, 'failed');
  assert.match(d!.lastError!, /Contenu refusé par le CRM \(title : trop long\)/);
  assert.ok(d!.nextAttemptAt.getTime() - Date.now() > 5 * 3_600_000, 'a rejected payload waits hours, not minutes');
  await later();
  assert.deepEqual(await status('announcement', a.id), ['delivered']);
  const sent = fleet.instance.changelog.get(`announcement:${a.id}`);
  assert.equal(sent.category, 'maintenance');
  assert.equal(sent.severity, 'warning');
  assert.equal(sent.audience, 'everyone');

  fleet.instance.changelogSeen.set(`announcement:${a.id}`, 4);
  await statsPass(p, new Date());
  [d] = await deliveriesOf(sql, 'announcement', a.id);
  assert.deepEqual([d!.seenUsers, d!.totalUsers], [4, 6]);
  const reach = (await reachByItem(sql, 'announcement')).get(a.id)!;
  assert.deepEqual([reach.delivered, reach.seen, reach.audience], [1, 4, 6]);

  await retract(sql, 'announcement', a.id);
  await deliveryPass(p, new Date());
  assert.equal(fleet.instance.changelog.has(`announcement:${a.id}`), false, 'removed from the CRM');
  assert.deepEqual(await status('announcement', a.id), ['retracted']);
});

test('an announcement aimed at other packs reaches nobody here', async () => {
  const a = await createAnnouncement(sql, { kind: 'billing', title: 'Tarifs 2027', body: '', severity: 'info', audience: 'managers', startsAt: null, endsAt: null, ctaLabel: null, ctaUrl: null, target: { packs: ['agence'] } }, null as never);
  assert.equal(a.queued, 0);
  const b = await createAnnouncement(sql, { kind: 'billing', title: 'Tarifs équipe', body: '', severity: 'info', audience: 'managers', startsAt: null, endsAt: null, ctaLabel: null, ctaUrl: null, target: { packs: ['equipe'] } }, null as never);
  assert.equal(b.queued, 1);
});
