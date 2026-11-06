import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { decryptStream, deriveBackupKey, encryptStream } from '../src/backup-crypto.ts';
import { cronMatches, parseCron } from '../src/cron.ts';
import { createSealer, hashPassword, verifyPassword } from '../src/crypto.ts';
import { can, isRole } from '../src/roles.ts';

const at = (iso: string) => new Date(iso);

test('cron: the CRM catalog schedules match the right minutes (UTC)', () => {
  assert.ok(cronMatches('* * * * *', at('2026-10-26T13:37:00Z')));
  assert.ok(cronMatches('*/5 * * * *', at('2026-10-26T13:35:00Z')));
  assert.ok(!cronMatches('*/5 * * * *', at('2026-10-26T13:36:00Z')));
  assert.ok(cronMatches('0 * * * *', at('2026-10-26T13:00:00Z')));
  assert.ok(cronMatches('0 4 * * *', at('2026-10-26T04:00:00Z')));
  assert.ok(!cronMatches('0 4 * * *', at('2026-10-26T05:00:00Z')));
  assert.ok(cronMatches('0 2 1 * *', at('2026-11-01T02:00:00Z')));
  assert.ok(!cronMatches('0 2 1 * *', at('2026-11-02T02:00:00Z')));
  assert.ok(cronMatches('0 9 * * 1-5', at('2026-10-26T09:00:00Z')), 'Monday');
  assert.ok(!cronMatches('0 9 * * 1-5', at('2026-10-25T09:00:00Z')), 'Sunday');
  assert.ok(cronMatches('0 9 * * 7', at('2026-10-25T09:00:00Z')), '7 = Sunday');
  assert.ok(cronMatches('0 9 1 * 1', at('2026-10-26T09:00:00Z')), 'day-of-month OR day-of-week');
  assert.ok(cronMatches('10-20/5 * * * *', at('2026-10-26T09:15:00Z')));
  assert.equal(parseCron('61 * * * *'), null);
  assert.equal(parseCron('* * *'), null);
  assert.equal(parseCron('*/0 * * * *'), null);
});

test('sealer and passwords', async () => {
  const s = createSealer('ab'.repeat(32));
  const sealed = s.seal('secret €');
  assert.notEqual(s.seal('secret €'), sealed, 'random IV');
  assert.equal(s.open(sealed), 'secret €');
  assert.throws(() => s.open(sealed.slice(0, -2) + 'AA'));
  assert.throws(() => createSealer('cd'.repeat(32)).open(sealed));
  const h = await hashPassword('un mot de passe long');
  assert.ok(await verifyPassword('un mot de passe long', h));
  assert.ok(!(await verifyPassword('autre', h)));
  assert.ok(!(await verifyPassword('x', null)));
});

async function collect(s: NodeJS.ReadableStream): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of s) out.push(Buffer.from(c as Buffer));
  return Buffer.concat(out);
}

test('backup encryption: round trip whatever the chunking, refuses a wrong key, a modified or truncated file', async () => {
  const key = deriveBackupKey('ab'.repeat(32));
  const plain = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const enc = await collect(Readable.from([plain.subarray(0, 7), plain.subarray(7, 4000), plain.subarray(4000)]).pipe(encryptStream(key)));
  assert.equal(enc.subarray(0, 4).toString(), 'CPBK');
  assert.equal(enc.length, plain.length + 33, 'header 17 + tag 16, no padding');
  for (const size of [1, 3, 16, 17, 33, 1000, enc.length]) {
    const chunks = Array.from({ length: Math.ceil(enc.length / size) }, (_, i) => enc.subarray(i * size, (i + 1) * size));
    assert.ok((await collect(Readable.from(chunks).pipe(decryptStream(key)))).equals(plain), `chunks of ${size}`);
  }
  assert.equal((await collect(Readable.from([Buffer.alloc(0)]).pipe(encryptStream(key)))).length, 33, 'an empty input still has a header and a tag');

  const fails = (data: Buffer, k = key) => assert.rejects(collect(Readable.from([data]).pipe(decryptStream(k))), /authenticate|tronquée|en-tête/);
  await fails(enc, deriveBackupKey('cd'.repeat(32)));
  const flipped = Buffer.from(enc);
  flipped[100] = flipped[100]! ^ 1;
  await fails(flipped);
  await fails(enc.subarray(0, enc.length - 5));
  await fails(Buffer.from('PGDMP plain dump'));
  assert.ok(!deriveBackupKey('ab'.repeat(32)).equals(Buffer.from('ab'.repeat(32), 'hex')), 'derived, not the sealer key itself');
});

test('roles: only the owner deletes and manages the team; support backs up; viewers read', () => {
  assert.ok(can('owner', 'agency.delete') && can('owner', 'team.manage') && can('owner', 'platform.download'));
  assert.ok(!can('operator', 'agency.delete') && !can('operator', 'team.manage') && !can('operator', 'platform.download'));
  assert.ok(can('operator', 'agency.restore') && can('operator', 'agency.create') && can('operator', 'agency.keys'));
  assert.ok(can('support', 'agency.backup') && can('support', 'alert.resolve'));
  assert.ok(!can('support', 'agency.restore') && !can('support', 'agency.download') && !can('support', 'agency.upgrade'));
  for (const perm of ['agency.backup', 'alert.resolve', 'agency.create'] as const) assert.ok(!can('viewer', perm), perm);
  assert.ok(!can(undefined, 'agency.backup'));
  assert.ok(isRole('support') && !isRole('admin'));
});

// The provisioning steps are vendored from the CRM repo. When this folder sits inside the CRM
// checkout (the usual case), the copies must not drift apart unnoticed.
test('vendored provisioning matches the CRM copy (when the CRM checkout is next to it)', (t) => {
  const crm = new URL('../../scripts/provision-agency/', import.meta.url);
  if (!existsSync(crm)) return t.skip('CRM checkout not found');
  const body = (text: string) =>
    text
      .replace(/\r\n/g, '\n')
      .replace(/^\/\/ =+\n(\/\/.*\n)*?\/\/ =+\n/, '') // header comment block
      .replace(/\.ts";/g, '";');
  const vendored = new URL('../src/provision/', import.meta.url);
  const plan = body(readFileSync(new URL('plan.ts', vendored), 'utf8'));
  assert.equal(plan, body(readFileSync(new URL('plan.ts', crm), 'utf8')), 'src/provision/plan.ts differs from scripts/provision-agency/plan.ts');
  // run.ts carries Console hooks (onStep, onInvite, stepCatalog): compare the step ids and labels.
  const steps = (text: string) => [...text.matchAll(/id: "([a-z-]+)",\n\s+label: "([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(steps(readFileSync(new URL('run.ts', vendored), 'utf8')), steps(readFileSync(new URL('run.ts', crm), 'utf8')));
});
