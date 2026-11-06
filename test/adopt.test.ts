// Adopting an agency created by the CRM's provision-agency CLI.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { adoptAgency, AdoptError } from '../src/adopt.ts';
import { readState } from '../src/agencies.ts';
import { createSealer } from '../src/crypto.ts';
import { createDb, type Sql } from '../src/db.ts';
import { setLogLevel } from '../src/log.ts';
import { migrate } from '../src/migrate.ts';
import { generateSecrets } from '../src/provision/plan.ts';

const PORT = 54341;
let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
const sealer = createSealer('cd'.repeat(32));

const config = { slug: 'demo', name: 'Agence Démo', manager: { email: 'm@example.com', name: 'M' }, brand: { primaryColor: '#1F3A5F' } };
const cliState = () => ({
  slug: 'demo',
  createdAt: '2026-10-26T00:00:00.000Z',
  secrets: generateSecrets(),
  primaryHost: 'demo.173-212-225-37.sslip.io',
  steps: { database: 'done' },
  dokployAppId: 'app-1',
  domains: ['demo.173-212-225-37.sslip.io'],
  imageTag: '005c979',
  deployedTag: '005c979',
});

before(async () => {
  setLogLevel('error');
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();
  sql = createDb(`postgres://postgres@127.0.0.1:${PORT}/postgres`, 1);
  await migrate(sql);
});

after(async () => {
  await sql.end({ timeout: 2 });
  await server.stop();
  await db.close();
});

test('adopt registers the agency as active with its secrets sealed', async () => {
  const state = cliState();
  const agency = await adoptAgency(sql, sealer, { state, config });
  assert.equal(agency.status, 'active');
  assert.equal(agency.primaryHost, 'demo.173-212-225-37.sslip.io');
  assert.equal(agency.imageTag, '005c979');
  assert.deepEqual(agency.domains, ['demo.173-212-225-37.sslip.io']);
  assert.ok(agency.stateEnc && !agency.stateEnc.includes(state.secrets.instanceAdminSecret), 'secrets are not stored in clear');
  const back = readState(sealer, agency)!;
  assert.equal(back.secrets.instanceAdminSecret, state.secrets.instanceAdminSecret);
  assert.equal(back.dokployAppId, 'app-1');
});

test('adopt refuses duplicates, mismatched slugs and states that are not provisioning states', async () => {
  await assert.rejects(adoptAgency(sql, sealer, { state: cliState(), config }), /déjà dans la Console/);
  await assert.rejects(adoptAgency(sql, sealer, { state: { ...cliState(), slug: 'autre' }, config }), /diffèrent/);
  await assert.rejects(adoptAgency(sql, sealer, { state: { slug: 'x', primaryHost: 'x.y.fr' }, config: { ...config, slug: 'xx' } }), AdoptError);
  await assert.rejects(adoptAgency(sql, sealer, { state: cliState(), config: { slug: 'A_B' } }), /agency\.json invalide/);
  await assert.rejects(adoptAgency(sql, sealer, { state: { ...cliState(), dokployAppId: undefined }, config: { ...config, slug: 'demo' } }), /déjà dans la Console|dokployAppId/);
});
