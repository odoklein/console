// Register an agency created by the CRM's `npm run provision-agency` in the Console:
//   npm run agency:adopt -- <provision-out/slug.json> <agency.json>

import { readFile } from 'node:fs/promises';
import { adoptAgency, AdoptError } from '../adopt.ts';
import { createSealer } from '../crypto.ts';
import { createDb } from '../db.ts';
import { migrate } from '../migrate.ts';

const [statePath, configPath] = process.argv.slice(2);
if (!statePath || !configPath) {
  console.error('Usage: npm run agency:adopt -- <provision-out/slug.json> <agency.json>');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
const key = process.env.CONSOLE_ENCRYPTION_KEY;
if (!url || !key || !/^[0-9a-f]{64}$/i.test(key)) {
  console.error('DATABASE_URL et CONSOLE_ENCRYPTION_KEY (64 caractères hexadécimaux) sont requis');
  process.exit(2);
}
const sql = createDb(url, 1);
try {
  await migrate(sql);
  const agency = await adoptAgency(sql, createSealer(key), {
    state: JSON.parse(await readFile(statePath, 'utf8')),
    config: JSON.parse(await readFile(configPath, 'utf8')),
  });
  console.log(`${agency.name} (${agency.slug}) est dans la Console: https://${agency.primaryHost}, image ${agency.imageTag}, état ${agency.status}.`);
} catch (err) {
  console.error(err instanceof AdoptError ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
