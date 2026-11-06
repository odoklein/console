// The web Console over a real Postgres (PGlite) and the fake fleet: sign-in with email and password,
// CSRF, the wizard, every page, the live job poll, the two-step delete.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createOperator } from '../src/auth.ts';
import { deriveBackupKey } from '../src/backup-crypto.ts';
import { createSealer } from '../src/crypto.ts';
import { createDb, type Sql } from '../src/db.ts';
import { createApp } from '../src/http/app.ts';
import { runOnce } from '../src/jobs/worker.ts';
import { setLogLevel } from '../src/log.ts';
import { migrate } from '../src/migrate.ts';
import type { Platform } from '../src/platform.ts';
import { makeFleet } from './fakes.ts';

const PORT = 54349;
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let p: Platform;
let app: ReturnType<typeof createApp>;
let fleet: ReturnType<typeof makeFleet>;
let cookie = '';
let csrf = '';

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
      shared: { SMTP_HOST: 'smtp.example', OPENAI_API_KEY: 'sk-platform-0123456789abcdef' },
      imageRepo: 'ghcr.io/x/crm',
      defaultTag: 'v1',
      dokployProject: 'agencies',
      retentionDays: 30,
      backupHourUtc: 2,
      drillDay: 1,
      healthFailuresBeforeAlert: 3,
      centralCron: true,
      consoleUrl: 'https://console.example',
      healthTimeoutMs: 30_000,
    },
    backupKey: deriveBackupKey('cd'.repeat(32)),
  };
  app = createApp({ p, secureCookies: false });
});

after(async () => {
  await sql.end();
  await server.stop();
  await db.close();
});

async function req(method: string, path: string, form?: Record<string, string> | FormData) {
  const headers: Record<string, string> = { cookie };
  let body: string | FormData | undefined;
  if (form instanceof FormData) body = form;
  else if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await app.request(path, { method, headers, body, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  const m = /name="_csrf" value="([^"]+)"/.exec(text);
  if (m) csrf = m[1]!;
  return { status: res.status, location: res.headers.get('location'), text };
}

test('setup link, password, then the fleet page (no second step)', async () => {
  const { setupToken } = await createOperator(sql, 'odo@example.fr', 'Odo', 'owner');
  assert.equal((await req('GET', '/')).location, '/login', 'anonymous users are sent to the login page');

  let r = await req('POST', `/setup/${setupToken}`, { password: 'court', confirm: 'court' });
  assert.equal(r.status, 400);
  r = await req('POST', `/setup/${setupToken}`, { password: 'un mot de passe long', confirm: 'un mot de passe long' });
  assert.equal(r.location, '/', 'signed in right after choosing the password');
  assert.equal((await req('GET', `/setup/${setupToken}`)).status, 410, 'the link works once');
  assert.equal((await req('GET', '/login/2fa')).location, '/', 'old second-step links lead home');

  r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Aucune agence pour l’instant/);
});

test('POST without the CSRF token is refused', async () => {
  const r = await req('POST', '/alerts/00000000-0000-0000-0000-000000000000/resolve', { _csrf: 'nope' });
  assert.equal(r.status, 403);
});

test('wizard: errors are explained, then a good submission creates the agency and its live job', async () => {
  await req('GET', '/agencies/new');
  let form = new FormData();
  form.set('_csrf', csrf);
  form.set('name', 'Agence Nord');
  form.set('slug', 'Admin');
  form.set('managerEmail', 'pas-un-email');
  form.set('pack', 'equipe');
  let r = await req('POST', '/agencies', form);
  assert.equal(r.status, 400);
  assert.match(r.text, /Nom court :/);
  assert.match(r.text, /Email du manager :/);
  assert.match(r.text, /value="Agence Nord"/, 'values are kept');

  const slug = await app.request('/api/slug?slug=agence-nord', { headers: { cookie } });
  assert.deepEqual(await slug.json(), { available: true, host: 'agence-nord.crm-agence.fr' });

  form = new FormData();
  for (const [k, v] of Object.entries({
    _csrf: csrf,
    name: 'Agence Nord',
    slug: 'agence-nord',
    legalName: 'Agence Nord SAS',
    timeZone: 'Europe/Brussels',
    managerName: 'Chef Nord',
    managerEmail: 'Chef@Agence-Nord.fr',
    primaryColor: '#123456',
    accentColor: '#e4572e',
    fontPreset: 'inter',
    addressMode: 'own',
    domain: 'crm.agence-nord.fr',
    pack: 'equipe',
    seatLimit: '',
    feature_aiAssistant: '1',
    billingEmail: 'compta@agence-nord.fr',
  }))
    form.set(k, v);
  form.set('logo_full', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])], 'logo.png', { type: 'image/png' }));
  form.set('logo_mark', new File(['not an image'], 'x.png', { type: 'image/png' }));
  r = await req('POST', '/agencies', form);
  assert.equal(r.status, 400, 'a fake PNG is refused');
  assert.match(r.text, /Logo « mark »/);

  form.delete('logo_mark');
  form.set('_csrf', csrf);
  r = await req('POST', '/agencies', form);
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.match(r.location!, /^\/jobs\/[0-9a-f-]{36}$/);

  const [a] = await sql<{ config: any; status: string }[]>`SELECT config, status FROM agencies WHERE slug = 'agence-nord'`;
  assert.equal(a!.status, 'provisioning');
  assert.equal(a!.config.manager.email, 'chef@agence-nord.fr');
  assert.equal(a!.config.license.seatLimit, 12, 'pack default when the field is empty');
  assert.deepEqual(a!.config.license.features, { callVault: false, aiAssistant: true, whiteLabel: false, agent: false });
  assert.equal(a!.config.brand.timeZone, 'Europe/Brussels');
  assert.equal(a!.config.brand.currency, 'EUR');
  assert.equal(a!.config.domain, 'crm.agence-nord.fr');
  assert.deepEqual(Object.keys(a!.config.logos), ['full']);

  // The job page, then the live poll once the worker ran it.
  r = await req('GET', r.location!);
  assert.match(r.text, /Base de données créée/);
  const jobId = /"id":"([0-9a-f-]{36})"/.exec(r.text)![1]!;
  while (await runOnce(p));
  const poll = (await (await app.request(`/jobs/${jobId}/poll`, { headers: { cookie } })).json()) as any;
  assert.equal(poll.status, 'succeeded', poll.error);
  assert.equal(poll.steps.find((s: { id: string }) => s.id === 'custom-domain').result, 'pending');
  assert.ok(poll.logs.length > 5);

  r = await req('GET', `/jobs/${jobId}`);
  assert.match(r.text, /Invitation du manager/);
  assert.match(r.text, /TOKEN123/);
});

test('agency page shows the pending DNS record and every section', async () => {
  const r = await req('GET', '/agencies/agence-nord');
  assert.equal(r.status, 200);
  for (const s of ['Santé', 'Adresse web', 'Offre', 'Sauvegardes', 'Opérations', 'Zone sensible', 'CNAME crm.agence-nord.fr → edge.crm-agence.fr']) assert.ok(r.text.includes(s), s);
  for (const path of ['/alerts', '/team', '/audit', '/fleet/upgrade', '/']) assert.equal((await req('GET', path)).status, 200, path);
  assert.match((await req('GET', '/audit')).text, /agency\.create/);
});

test('keys: an agency made by the wizard never receives the platform\'s integration keys', async () => {
  assert.match(fleet.instance.lastEnv, /SMTP_HOST=smtp\.example/, 'platform plumbing still reaches the agency');
  assert.ok(!fleet.instance.envKeys.has('OPENAI_API_KEY'), 'the platform OpenAI key is withheld');

  let r = await req('GET', '/agencies/agence-nord/keys');
  assert.equal(r.status, 200);
  for (const s of ['Figé à la création', 'Clés de l’agence', 'Commun à toutes les agences', 'ENCRYPTION_KEY', 'scellé']) assert.ok(r.text.includes(s), s);
  assert.match(r.text, /class="chip chip-off"[^>]*><code>OPENAI_API_KEY/, 'withheld key shown struck through');
  assert.ok(!r.text.includes('sk-platform'), 'no secret value is ever rendered');
  assert.ok(!r.text.includes('Passer aux clés'), 'new agencies are already on their own keys');

  r = await req('POST', '/agencies/agence-nord/keys', { _csrf: csrf, name: 'OPENAI_API_KEY', value: 'sk avec espace' });
  assert.equal(r.status, 400);
  assert.match(r.text, /ni espace/);
  r = await req('POST', '/agencies/agence-nord/keys', { _csrf: csrf, name: 'NOT_A_KEY', value: 'x' });
  assert.equal(r.status, 400);

  r = await req('POST', '/agencies/agence-nord/keys', { _csrf: csrf, name: 'OPENAI_API_KEY', value: '  sk-agence-nord-0123456789  ' });
  assert.equal(r.status, 302);
  assert.match(r.location!, /saved=OPENAI_API_KEY/);
  assert.equal(fleet.instance.keys.get('OPENAI_API_KEY'), 'sk-agence-nord-0123456789');
  assert.match((await req('GET', r.location!)).text, /enregistrée/);

  r = await req('POST', '/agencies/agence-nord/keys', { _csrf: csrf, name: 'OPENAI_API_KEY', remove: '1' });
  assert.match(r.location!, /removed=OPENAI_API_KEY/);
  assert.ok(!fleet.instance.keys.has('OPENAI_API_KEY'));
  assert.match((await req('GET', '/audit')).text, /keys\.set/);
});

test('keys: a legacy agency is migrated by copying its current keys first, then withholding them', async () => {
  await sql`UPDATE agencies SET config = config #- '{extra,keys}' WHERE slug = 'agence-nord'`;
  fleet.instance.envKeys.add('OPENAI_API_KEY');
  let r = await req('GET', '/agencies/agence-nord/keys');
  assert.match(r.text, /reçoit encore les clés de la plateforme/);
  assert.match(r.text, /<strong>OPENAI_API_KEY<\/strong>/);

  r = await req('POST', '/agencies/agence-nord/keys/adopt', { _csrf: csrf });
  assert.equal(r.status, 302);
  assert.equal(fleet.instance.keys.get('OPENAI_API_KEY'), 'sk-platform-0123456789abcdef', 'the value in use is carried over');
  const [a] = await sql<{ config: any }[]>`SELECT config FROM agencies WHERE slug = 'agence-nord'`;
  assert.equal(a!.config.extra.keys, 'agency');
  assert.ok(!(await req('GET', '/agencies/agence-nord/keys')).text.includes('Passer aux clés'));
});

test('fleet upgrade is a rollout: one agency at a time, shown on the fleet page', async () => {
  await req('GET', '/fleet/upgrade');
  let r = await req('POST', '/fleet/upgrade', { _csrf: csrf, tag: 'v2', agency: (await sql`SELECT id FROM agencies WHERE slug = 'agence-nord'`)[0]!.id });
  assert.equal(r.location, '/');
  r = await req('GET', '/');
  assert.match(r.text, /Mise à jour de la flotte vers <code>v2<\/code>/);
  assert.match(r.text, /En cours/);
  while (await runOnce(p));
  r = await req('GET', '/');
  assert.match(r.text, /Terminée/);
  assert.match(r.text, /1\/1 à jour/);
  assert.match((await req('GET', '/audit')).text, /Mise à jour de la flotte lancée/);
});

test('roles: a viewer reads but acts on nothing, support may back up, the owner closes sessions', async () => {
  const ownerCookie = cookie;
  await req('GET', '/team');
  let r = await req('POST', '/team', { _csrf: csrf, name: 'Vera', email: 'vera@example.fr', role: 'viewer' });
  const link = /\/setup\/([A-Za-z0-9_-]+)/.exec(r.text)![1]!;
  const [vera] = await sql<{ id: string; role: string }[]>`SELECT id, role FROM operators WHERE email = 'vera@example.fr'`;
  assert.equal(vera!.role, 'viewer');

  cookie = '';
  r = await req('POST', `/setup/${link}`, { password: 'vera mot de passe long', confirm: 'vera mot de passe long' });
  assert.equal(r.location, '/');
  const veraCookie = cookie;
  r = await req('GET', '/agencies/agence-nord');
  assert.equal(r.status, 200, 'reading is open to every role');
  assert.ok(!r.text.includes('Sauvegarder maintenant') && !r.text.includes('Zone sensible'), 'no action buttons for a viewer');
  assert.ok(!r.text.includes('href="/agencies/new"'), 'no "Nouvelle agence" in the navigation');
  assert.equal((await req('GET', '/agencies/new')).status, 403);
  assert.equal((await req('POST', '/agencies/agence-nord/actions/backup', { _csrf: csrf })).status, 403);
  assert.equal((await req('POST', '/team', { _csrf: csrf, name: 'X', email: 'x@example.fr' })).status, 403);
  assert.ok(!(await req('GET', '/agencies/agence-nord/keys')).text.includes('Enregistrer'), 'keys are read-only');

  cookie = ownerCookie;
  await req('GET', '/team');
  r = await req('POST', `/team/${vera!.id}/role`, { _csrf: csrf, role: 'support' });
  assert.match(r.text, /Vera : Support/);

  cookie = veraCookie;
  await req('GET', '/agencies/agence-nord');
  r = await req('POST', '/agencies/agence-nord/actions/backup', { _csrf: csrf });
  assert.match(r.location!, /^\/jobs\//, 'support may back up');
  while (await runOnce(p));
  const [b] = await sql<{ id: string }[]>`SELECT id FROM backups ORDER BY created_at DESC LIMIT 1`;
  assert.equal((await req('GET', `/agencies/agence-nord/backups/${b!.id}/download`)).status, 403, 'support may not download');
  assert.equal((await req('GET', `/agencies/agence-nord/restore/${b!.id}`)).status, 403, 'support may not restore');

  cookie = ownerCookie;
  r = await req('GET', '/team');
  assert.match(r.text, /cette session/);
  const hash = /\/sessions\/([0-9a-f]{64})\/revoke/.exec(r.text)![1]!;
  r = await req('POST', `/sessions/${hash}/revoke`, { _csrf: csrf });
  assert.match(r.text, /Session fermée/);
  cookie = veraCookie;
  assert.equal((await req('GET', '/')).location, '/login', 'her session is gone');
  cookie = ownerCookie;
  await req('GET', '/');
});

test('download of an encrypted backup comes back decrypted, through the Console', async () => {
  const [b] = await sql<{ id: string; objectKey: string; encrypted: boolean }[]>`SELECT id, object_key, encrypted FROM backups ORDER BY created_at DESC LIMIT 1`;
  assert.equal(b!.encrypted, true);
  assert.equal(fleet.objects.get(b!.objectKey)!.subarray(0, 4).toString(), 'CPBK', 'stored encrypted');
  const res = await app.request(`/agencies/agence-nord/backups/${b!.id}/download`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition')!, /\.dump"$/);
  assert.match(await res.text(), /^PGDMP\|db_agence_nord\|/);
});

test('journal: filters, CSV export', async () => {
  let r = await req('GET', '/audit?action=operator.');
  assert.match(r.text, /Rôle changé/);
  assert.ok(!r.text.includes('Agence créée'), 'other families are filtered out');
  r = await req('GET', '/audit?agency=agence-nord&action=job.');
  assert.match(r.text, /Sauvegarde lancée/);
  const res = await app.request('/audit.csv?action=operator.', { headers: { cookie } });
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const text = bytes.toString('utf8');
  assert.match(text, /date \(UTC\);personne;action;code/);
  assert.match(text, /operator\.role/);
  assert.ok(!text.includes('agency.create'));
});

test('platform page: the Console\'s own backups, the off-site copy and the encryption', async () => {
  const r = await req('GET', '/platform');
  assert.equal(r.status, 200);
  for (const s of ['Sauvegarde de la Console', 'Copie hors site', 'b2.example/console-offsite', 'Chiffrement', 'npm run backup:decrypt']) assert.ok(r.text.includes(s), s);
});

test('security headers: the CSP lets Google Fonts in and nothing else', async () => {
  const csp = (await app.request('/login')).headers.get('content-security-policy')!;
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com;/);
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com;/);
  assert.match(csp, /script-src 'self';/);
});

test('backup from the page, then delete needs both confirmations', async () => {
  await req('GET', '/agencies/agence-nord');
  let r = await req('POST', '/agencies/agence-nord/actions/backup', { _csrf: csrf });
  assert.match(r.location!, /^\/jobs\//);
  while (await runOnce(p));

  await req('GET', '/agencies/agence-nord/delete');
  r = await req('POST', '/agencies/agence-nord/delete/review', { _csrf: csrf, confirm: 'wrong' });
  assert.equal(r.location, '/agencies/agence-nord/delete');
  r = await req('POST', '/agencies/agence-nord/actions/delete', { _csrf: csrf, confirm: 'agence-nord' });
  assert.equal(r.status, 400, 'the final step without the review token is refused');

  r = await req('POST', '/agencies/agence-nord/delete/review', { _csrf: csrf, confirm: 'agence-nord' });
  assert.match(r.text, /\(2\/2\)/);
  assert.match(r.text, /Votre mot de passe Console/, 'the second page asks for the password again');
  const review = /name="review" value="([0-9a-f]+)"/.exec(r.text)![1]!;
  r = await req('POST', '/agencies/agence-nord/actions/delete', { _csrf: csrf, confirm: 'agence-nord', review, skipExport: '', password: 'pas le bon' });
  assert.equal(r.status, 400, 'a wrong password launches nothing');
  assert.match(r.text, /Mot de passe incorrect/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'delete'`)[0]!.n, 0);
  r = await req('POST', '/agencies/agence-nord/actions/delete', { _csrf: csrf, confirm: 'agence-nord', review, skipExport: '', password: 'un mot de passe long' });
  assert.match(r.location!, /^\/jobs\//);
  while (await runOnce(p));
  const [a] = await sql`SELECT status FROM agencies WHERE slug = 'agence-nord'`;
  assert.equal(a!.status, 'deleted');
});

test('throttling: five wrong passwords lock the account for 15 minutes', async () => {
  await sql`DELETE FROM login_attempts`; // the wrong confirmation password above counts too
  for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/login', { email: 'odo@example.fr', password: 'faux' })).status, 401);
  assert.equal((await req('POST', '/login', { email: 'odo@example.fr', password: 'un mot de passe long' })).status, 429);
});
