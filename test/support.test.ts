// Support inbox: every agency's Support Technique tickets synced into the Console, read live,
// answered and moved from the Console, over a real Postgres (PGlite) and the fake fleet.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { adoptAgency } from '../src/adopt.ts';
import { getAgency } from '../src/agencies.ts';
import { createOperator } from '../src/auth.ts';
import { createSealer } from '../src/crypto.ts';
import { createDb, type Sql } from '../src/db.ts';
import { createApp } from '../src/http/app.ts';
import { setLogLevel } from '../src/log.ts';
import { migrate } from '../src/migrate.ts';
import type { Platform } from '../src/platform.ts';
import { generateSecrets } from '../src/provision/plan.ts';
import { tick } from '../src/scheduler.ts';
import { filterQuery, parseActionForm, parseFilters, supportPass, syncAgencySupport } from '../src/support.ts';
import { makeFleet, type FakeTicket } from './fakes.ts';

const PORT = 54369;
const NORD = 'agence-nord.crm-agence.fr';
const SUD = 'agence-sud.crm-agence.fr';
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let p: Platform;
let app: ReturnType<typeof createApp>;
let fleet: ReturnType<typeof makeFleet>;
let cookie = '';
let csrf = '';

function ticket(id: string, number: number, over: Partial<FakeTicket> = {}): FakeTicket {
  const at = '2026-10-26T09:00:00.000Z';
  return {
    id,
    number,
    title: `Ticket ${number}`,
    description: `Description du ticket ${number}`,
    category: 'BUG',
    scope: 'INTERNAL',
    priority: 'MEDIUM',
    status: 'NEW',
    validation: 'NOT_REQUIRED',
    requester: { name: 'Sami', role: 'SDR' },
    createdAt: at,
    updatedAt: at,
    dueDate: null,
    thread: [],
    ...over,
  };
}

async function adopt(slug: string, host: string, name: string) {
  const state = { slug, createdAt: '2026-10-26T00:00:00.000Z', secrets: generateSecrets(), primaryHost: host, steps: {}, dokployAppId: `app-${slug}`, domains: [host], imageTag: 'v1', deployedTag: 'v1' };
  return adoptAgency(sql, p.sealer, { state, config: { slug, name, manager: { email: `m@${slug}.fr`, name: 'M' }, brand: { primaryColor: '#1F3A5F' } } });
}

async function req(method: string, path: string, form?: Record<string, string>) {
  const headers: Record<string, string> = { cookie };
  let body: string | undefined;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ _csrf: csrf, ...form }).toString();
  }
  const res = await app.request(path, { method, headers, body, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  const m = /name="_csrf" value="([^"]+)"/.exec(text);
  if (m) csrf = m[1]!;
  return { status: res.status, location: res.headers.get('location'), text };
}

async function signIn(email: string, role: 'owner' | 'viewer') {
  cookie = '';
  const { setupToken } = await createOperator(sql, email, role === 'owner' ? 'Inès Martin' : 'Lou Lecture', role);
  await req('POST', `/setup/${setupToken}`, { password: 'un mot de passe long', confirm: 'un mot de passe long' });
}

before(async () => {
  setLogLevel('error');
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  sql = createDb(`postgres://postgres@127.0.0.1:${PORT}/postgres`, 1);
  await migrate(sql);
  fleet = makeFleet();
  p = {
    sql,
    infra: fleet.infra,
    sealer: createSealer('cd'.repeat(32)),
    settings: {
      platformDomain: 'crm-agence.fr',
      pg: { host: 'pg', port: 5432 },
      pgFromConsole: { host: 'pg', port: 5432 },
      minio: { endpoint: 'https://minio', accessKeyId: 'a', secretAccessKey: 'b' },
      shared: {},
      imageRepo: 'ghcr.io/x/crm',
      defaultTag: 'v1',
      dokployProject: 'agencies',
      retentionDays: 30,
      backupHourUtc: 2,
      drillDay: 1,
      healthFailuresBeforeAlert: 3,
      centralCron: false,
      consoleUrl: 'https://console.example',
    },
  };
  app = createApp({ p, secureCookies: false });
  await adopt('agence-nord', NORD, 'Agence Nord');
  await adopt('agence-sud', SUD, 'Agence Sud');
  // Both instances up, so the health pass of the same tick keeps them syncable.
  fleet.apps.set('app-agence-nord', { running: 'v1', domains: [NORD] });
  fleet.apps.set('app-agence-sud', { running: 'v1', domains: [SUD] });
  fleet.supportFor(NORD).tickets.push(
    ticket('t1', 1, { title: 'Export CSV vide', priority: 'URGENT' }),
    ticket('t2', 2, { title: 'Rappels en double', status: 'IN_PROGRESS', updatedAt: '2026-10-26T09:30:00.000Z' }),
    ticket('t3', 3, { title: 'Ancien bug', status: 'COMPLETED' }),
  );
  fleet.supportFor(SUD).tickets.push(ticket('s1', 1, { title: 'Connexion Gmail impossible', category: 'TECHNICAL_SUPPORT' }));
});

after(async () => {
  await sql.end({ timeout: 2 });
  await server.stop();
  await db.close();
});

test('the scheduler pulls every agency\'s tickets, then only what changed', async () => {
  const started = await tick(p, p.infra.now());
  await Promise.all(started);
  const rows = await sql<{ ref: string; title: string; agencyId: string }[]>`SELECT ref, title, agency_id FROM support_tickets ORDER BY title`;
  assert.deepEqual(rows.map((r) => r.title), ['Ancien bug', 'Connexion Gmail impossible', 'Export CSV vide', 'Rappels en double']);
  const nord = fleet.supportFor(NORD);
  assert.equal(nord.queries.length, 1);
  assert.doesNotMatch(nord.queries[0]!, /updatedSince/, 'first pass is a full listing');

  // An urgent ticket opens one alert for its agency.
  const [alert] = await sql<{ message: string }[]>`SELECT message FROM alerts WHERE key = 'support-urgent' AND resolved_at IS NULL`;
  assert.match(alert!.message, /#TC-0001 · Export CSV vide/);
  assert.ok(fleet.alerts.some((a) => a.startsWith('Agence Nord')), 'the team is notified');

  // Within 2 minutes nothing is asked again; after, only tickets changed since the last serverTime.
  await supportPass(p, new Date(p.infra.now().getTime() + 30_000));
  assert.equal(nord.queries.length, 1);
  fleet.advance(3 * 60_000);
  nord.tickets.find((t) => t.id === 't2')!.title = 'Rappels envoyés en double';
  nord.tickets.find((t) => t.id === 't2')!.updatedAt = p.infra.now().toISOString();
  await supportPass(p, p.infra.now());
  assert.match(nord.queries[1]!, /updatedSince=2026-10-26T10%3A00%3A00/);
  const [t2] = await sql<{ title: string }[]>`SELECT title FROM support_tickets WHERE ticket_id = 't2'`;
  assert.equal(t2!.title, 'Rappels envoyés en double');
});

test('one agency down is recorded and never blocks the others; a full pass drops deleted tickets', async () => {
  const sud = fleet.supportFor(SUD);
  sud.down = true;
  fleet.supportFor(NORD).tickets.push(ticket('t4', 4, { title: 'Nouveau ticket', updatedAt: new Date(p.infra.now().getTime() + 60_000).toISOString() }));
  fleet.advance(3 * 60_000);
  await supportPass(p, p.infra.now());
  const sync = await sql<{ slug: string; error: string | null }[]>`SELECT a.slug, s.error FROM support_sync s JOIN agencies a ON a.id = s.agency_id ORDER BY a.slug`;
  assert.equal(sync[0]!.error, null);
  assert.match(sync[1]!.error!, /Le CRM ne répond pas/);
  assert.equal((await sql`SELECT 1 FROM support_tickets WHERE ticket_id = 't4'`).length, 1, 'nord kept syncing');
  assert.equal((await sql`SELECT 1 FROM support_tickets WHERE ticket_id = 's1'`).length, 1, 'sud keeps its cached tickets');

  // An image without the support API says so in plain words.
  sud.down = false;
  sud.missing = true;
  const a = (await getAgency(sql, 'agence-sud'))!;
  const r = await syncAgencySupport(p, a, p.infra.now());
  assert.match(r.error!, /pas encore l’API support/);
  sud.missing = false;

  // Deleted in the CRM: gone from the cache at the next full pass (once a day).
  const nord = fleet.supportFor(NORD);
  nord.tickets.splice(nord.tickets.findIndex((t) => t.id === 't3'), 1);
  await syncAgencySupport(p, (await getAgency(sql, 'agence-nord'))!, p.infra.now(), { full: true });
  assert.equal((await sql`SELECT 1 FROM support_tickets WHERE ticket_id = 't3'`).length, 0);
});

test('inbox: views, unread, opening a ticket reads it live and marks it read', async () => {
  await signIn('ines@example.fr', 'owner');
  let r = await req('GET', '/support');
  assert.equal(r.status, 200);
  assert.match(r.text, /Export CSV vide/);
  assert.match(r.text, /Connexion Gmail impossible/);
  assert.doesNotMatch(r.text, /Ancien bug/, 'completed tickets are out of the default view');
  assert.match(r.text, /id="nav-support-badge"[^>]*>4</, 'four open tickets, none read yet');

  r = await req('GET', '/support?view=urgent');
  assert.match(r.text, /Export CSV vide/);
  assert.doesNotMatch(r.text, /Rappels envoyés/);

  r = await req('GET', '/support?agency=agence-sud');
  assert.match(r.text, /Connexion Gmail impossible/);
  assert.doesNotMatch(r.text, /Export CSV vide/);

  r = await req('GET', '/support?q=TC-0002');
  assert.match(r.text, /Rappels envoyés en double/);
  assert.doesNotMatch(r.text, /Export CSV vide/);

  r = await req('GET', '/support?t=agence-nord/t1');
  assert.match(r.text, /Description du ticket 1/, 'the thread starts with the description');
  assert.match(r.text, /a ouvert le ticket/);
  assert.match(r.text, /data-composer/);
  assert.match(r.text, /href="https:\/\/agence-nord\.crm-agence\.fr\/manager\/tickets\?ticket=t1"/);
  assert.match(r.text, /id="nav-support-badge"[^>]*>3</, 'opened: one fewer unread');

  r = await req('GET', '/support?t=agence-nord/nope');
  assert.match(r.text, /supprimé dans le CRM/);
  r = await req('GET', '/support?t=../etc');
  assert.equal(r.status, 200, 'a malformed ticket key is ignored');
});

test('reply, reply-and-move, priority: sent to the CRM signed with the operator, refusals shown in place', async () => {
  const nord = fleet.supportFor(NORD);
  let r = await req('POST', '/support/t/agence-nord/t1', { action: 'comment', content: 'On regarde, merci pour la capture.', view: 'urgent' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/support?view=urgent&t=agence-nord%2Ft1&sent=1', 'back to the same view, on the same ticket');
  assert.deepEqual(nord.posts.at(-1), { action: 'comment', content: 'On regarde, merci pour la capture.', operator: 'Inès Martin' });

  r = await req('GET', '/support?t=agence-nord/t1&sent=1');
  assert.match(r.text, /Envoyé dans le CRM/);
  assert.match(r.text, /msg is-platform/);
  assert.match(r.text, /— Inès Martin, Support plateforme/);
  const [t1] = await sql<{ at: Date | null }[]>`SELECT last_platform_reply_at AS at FROM support_tickets WHERE ticket_id = 't1'`;
  assert.ok(t1!.at, 'the ticket leaves the "Sans réponse" view');
  r = await req('GET', '/support?view=unanswered');
  assert.doesNotMatch(r.text, /Export CSV vide/);

  // Reply and move in one send.
  r = await req('POST', '/support/t/agence-nord/t1', { action: 'comment', content: 'Correctif en cours.', status: 'IN_PROGRESS' });
  assert.equal(r.status, 302);
  assert.deepEqual(nord.posts.at(-1), { action: 'status', status: 'IN_PROGRESS', comment: 'Correctif en cours.', operator: 'Inès Martin' });

  // The CRM refuses IN_PROGRESS → COMPLETED: its words, the text kept.
  r = await req('POST', '/support/t/agence-nord/t1', { action: 'comment', content: 'Terminé !', status: 'COMPLETED' });
  assert.equal(r.status, 422);
  assert.match(r.text, /Le CRM refuse : Transition de statut invalide/);
  assert.match(r.text, />Terminé !<\/textarea>/);

  r = await req('POST', '/support/t/agence-nord/t1', { action: 'comment', content: '   ' });
  assert.equal(r.status, 400);
  assert.match(r.text, /Écrivez une réponse/);

  r = await req('POST', '/support/t/agence-nord/t1', { action: 'priority', priority: 'LOW' });
  assert.equal(r.status, 302);
  assert.equal(nord.tickets.find((t) => t.id === 't1')!.priority, 'LOW');

  // No urgent ticket left: the alert resolves at the next pass.
  fleet.advance(3 * 60_000);
  await supportPass(p, p.infra.now());
  assert.equal((await sql`SELECT 1 FROM alerts WHERE key = 'support-urgent' AND resolved_at IS NULL`).length, 0);

  const journal = await sql<{ action: string }[]>`SELECT action FROM audit_log WHERE action LIKE 'support.%' ORDER BY id`;
  assert.deepEqual(journal.map((j) => j.action), ['support.reply', 'support.status', 'support.priority']);

  r = await req('GET', '/');
  assert.match(r.text, /href="\/support\?agency=agence-nord"/, 'the fleet table links each agency to its tickets');
});

test('canned replies, manual sync, and a viewer who reads but cannot answer', async () => {
  let r = await req('POST', '/support/macros', { title: '', body: 'x' });
  assert.equal(r.status, 400);
  r = await req('POST', '/support/macros', { title: 'Correctif déployé', body: 'Bonjour, le correctif est en ligne.' });
  assert.equal(r.location, '/support/macros');
  r = await req('GET', '/support?t=agence-sud/s1');
  assert.match(r.text, /<option value="[0-9a-f-]{36}">Correctif déployé<\/option>/);
  assert.match(r.text, /Bonjour, le correctif est en ligne\./, 'the text travels to the page for insertion');

  const before = fleet.supportFor(SUD).queries.length;
  r = await req('POST', '/support/sync', { view: 'all' });
  assert.equal(r.location, '/support?view=all');
  assert.equal(fleet.supportFor(SUD).queries.length, before + 1);

  const [macro] = await sql<{ id: string }[]>`SELECT id FROM support_macros`;
  await signIn('lou@example.fr', 'viewer');
  r = await req('GET', '/support?t=agence-sud/s1');
  assert.equal(r.status, 200);
  assert.match(r.text, /Votre rôle permet de lire les tickets/);
  assert.doesNotMatch(r.text, /data-composer/);
  r = await req('POST', '/support/t/agence-sud/s1', { action: 'comment', content: 'coucou' });
  assert.equal(r.status, 403);
  r = await req('POST', `/support/macros/${macro!.id}/delete`, {});
  assert.equal(r.status, 403);
});

test('filters and forms are checked before anything reaches a CRM', () => {
  const f = parseFilters({ view: 'urgent', agency: 'agence-nord', status: 'DROP', priority: 'HIGH', q: '  export  ', page: '-3' });
  assert.deepEqual(f, { view: 'urgent', agency: 'agence-nord', status: null, priority: 'HIGH', category: null, q: 'export', page: 1 });
  assert.equal(parseFilters({ view: 'nope', agency: '../x' }).view, 'open');
  assert.equal(parseFilters({ agency: '../x' }).agency, null);
  assert.equal(filterQuery({ view: 'open', page: 1 }), '');
  assert.equal(filterQuery({ view: 'done', agency: 'a', t: 'a/b' }), '?view=done&agency=a&t=a%2Fb');

  assert.deepEqual(parseActionForm({ action: 'comment', content: ' Bonjour ' }), { ok: true, value: { action: 'comment', content: 'Bonjour' } });
  assert.deepEqual(parseActionForm({ action: 'comment', content: '', status: 'TESTING' }), { ok: true, value: { action: 'status', status: 'TESTING', comment: undefined } });
  assert.equal(parseActionForm({ action: 'comment', content: 'x'.repeat(10_001) }).ok, false);
  assert.equal(parseActionForm({ action: 'priority', priority: 'CRITICAL' }).ok, false);
  assert.equal(parseActionForm({ action: 'delete' }).ok, false);
});
