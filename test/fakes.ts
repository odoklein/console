// A fake fleet: Postgres cluster, MinIO, Dokploy, docker, the public proxy and the CRM
// instance API (signature checked like the real one), all in memory.

import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Infra } from '../src/infra/types.ts';
import { INTEGRATION_KEY_NAMES } from '../src/integration-keys.ts';

async function collect(body: Readable | Uint8Array): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

function verify(secret: string, method: string, path: string, body: unknown, headers: Record<string, string>): boolean {
  const bytes = body == null ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array);
  const canonical = `${headers['X-Instance-Timestamp']}.${method}.${path}.${createHash('sha256').update(bytes).digest('hex')}`;
  return headers['X-Instance-Signature'] === `v1=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

export function makeFleet() {
  const calls: string[] = [];
  const databases = new Map<string, { owner: string; content: string }>();
  const roles = new Set<string>();
  const buckets = new Map<string, number>();
  const objects = new Map<string, Buffer>();
  /** The off-site bucket (Backblaze B2 in production). */
  const offsiteObjects = new Map<string, Buffer>();
  const offsiteState = { down: false };
  const apps = new Map<string, { image?: string; running?: string; stopped?: boolean; domains: string[] }>();
  const routes = new Map<string, string>();
  const instance = {
    users: 0,
    license: { status: 'ACTIVE' as string, plan: null as string | null, seatLimit: null as number | null },
    badTags: new Set<string>(),
    down: false,
    cronCalls: [] as string[],
    cronFails: new Set<string>(),
    exports: new Map<string, number>(),
    badSignatures: 0,
    /** Integration keys stored in the agency's database (PUT /api/instance/integrations). */
    keys: new Map<string, string>(),
    /** Keys present in the last env file Dokploy received. */
    envKeys: new Set<string>(),
    lastEnv: '',
  };
  const invites: { to: string; url: string }[] = [];
  const alerts: string[] = [];
  let clock = Date.parse('2026-10-26T10:00:00Z');
  let appSeq = 0;

  const running = () => [...apps.values()].find((a) => a.running)?.running ?? '';

  const infra: Infra = {
    pg: {
      roleExists: async (r) => roles.has(r),
      databaseExists: async (d) => databases.has(d),
      createRole: async (r) => void (roles.add(r), calls.push(`pg.createRole:${r}`)),
      setRolePassword: async () => void calls.push('pg.setRolePassword'),
      createDatabase: async (d, owner) => void (databases.set(d, { owner, content: '' }), calls.push(`pg.createDatabase:${d}`)),
      dropDatabase: async (d) => void (databases.delete(d), calls.push(`pg.dropDatabase:${d}`)),
      dropRole: async (r) => void (roles.delete(r), calls.push(`pg.dropRole:${r}`)),
      scalar: async (db, q) => {
        const content = databases.get(db)?.content ?? '';
        if (q.includes('_prisma_migrations')) return content.includes('schema') ? '42' : '0';
        if (q.includes('"User"')) return String((content.match(/user/g) ?? []).length);
        return null;
      },
    },
    storage: {
      ensureBucket: async (b) => void (buckets.has(b) || buckets.set(b, 1234), calls.push(`storage.ensureBucket:${b}`)),
      scopedKey: async (b, ak) => void calls.push(`storage.scopedKey:${b}:${ak}`),
      removeBucket: async (b) => void (buckets.delete(b), calls.push(`storage.removeBucket:${b}`)),
      bucketSize: async (b) => buckets.get(b) ?? 0,
      removeKey: async (ak) => void calls.push(`storage.removeKey:${ak}`),
    },
    backups: {
      put: async (key, body) => {
        const buf = await collect(body);
        objects.set(key, buf);
        return buf.length;
      },
      get: async (key) => {
        const b = objects.get(key);
        if (!b) throw new Error(`no object ${key}`);
        return Readable.from([b]);
      },
      remove: async (key) => void objects.delete(key),
      url: async (key) => `https://backups.example/${key}`,
    },
    offsite: {
      label: 'b2.example/console-offsite',
      put: async (key, body) => {
        if (offsiteState.down) throw new Error('getaddrinfo ENOTFOUND b2.example');
        const buf = await collect(body);
        offsiteObjects.set(key, buf);
        return buf.length;
      },
      remove: async (key) => void offsiteObjects.delete(key),
    },
    dumper: {
      dump(t) {
        const db = databases.get(t.database);
        const stream = Readable.from([Buffer.from(`PGDMP|${t.database}|${db?.content ?? ''}|`.padEnd(200, '.'))]);
        return { stream, done: db ? Promise.resolve() : Promise.reject(new Error(`database ${t.database} does not exist`)) };
      },
      async restore(t, input, opts) {
        const text = (await collect(input)).toString();
        const content = text.split('|')[2] ?? '';
        const db = databases.get(t.database);
        if (!db) throw new Error(`database ${t.database} does not exist`);
        if (!opts.clean && db.content) throw new Error('restore into a non-empty database without --clean');
        db.content = content;
        calls.push(`restore:${t.database}`);
      },
    },
    runDbJob: async (job, input) => {
      calls.push(`db.${job}:${input.image.split(':').pop()}`);
      const db = [...databases.entries()].find(([name]) => input.databaseUrl.includes(`/${name}`));
      if (db && job === 'migrate') db[1].content = (db[1].content + ' schema').trim();
    },
    dokploy: {
      findEnvironmentId: async () => 'env-1',
      findApplication: async (_p, name) => (apps.has(name) ? name : null),
      createApplication: async (i) => {
        appSeq++;
        apps.set(i.name, { domains: [] });
        calls.push(`dokploy.create:${i.name}`);
        return i.name;
      },
      saveDockerProvider: async (i) => void ((apps.get(i.applicationId)!.image = i.dockerImage.split(':').pop()), calls.push(`dokploy.image:${i.dockerImage.split(':').pop()}`)),
      saveEnvironment: async (_id, text) => {
        instance.lastEnv = text;
        instance.envKeys = new Set(text.split('\n').map((l) => l.split('=')[0]!).filter(Boolean));
        calls.push('dokploy.env');
      },
      createDomain: async (i) => void apps.get(i.applicationId)!.domains.push(i.host),
      listDomains: async (id) => [...(apps.get(id)?.domains ?? [])],
      deploy: async (id) => {
        const a = apps.get(id)!;
        a.running = a.image;
        a.stopped = false;
        calls.push(`dokploy.deploy:${a.image}`);
      },
      stop: async (id) => void ((apps.get(id)!.stopped = true), calls.push('dokploy.stop')),
      start: async (id) => void ((apps.get(id)!.stopped = false), calls.push('dokploy.start')),
      deleteApplication: async (id) => void (apps.delete(id), calls.push(`dokploy.delete:${id}`)),
    },
    instance: (_base, secret) => async (method, path, body, headers = {}) => {
      const signed = (await import('../src/provision/instance-auth.ts')).signInstanceRequest({ secret, method, pathWithQuery: path, body });
      if (!verify(secret, method, path, body, signed as Record<string, string>)) instance.badSignatures++;
      const app = [...apps.values()][0];
      if (instance.down || !app || app.stopped) throw new Error('connect ECONNREFUSED');
      void headers;
      const json = typeof body === 'string' && body ? JSON.parse(body) : undefined;
      if (path === '/api/instance/health') {
        if (instance.badTags.has(running())) return { status: 502, json: 'Bad Gateway' };
        return { status: 200, json: { version: running(), schemaVersion: '20261026100000_add_instance_license', dbOk: true, license: { ...instance.license, seatsUsed: instance.users } } };
      }
      if (path === '/api/instance/bootstrap') {
        if (instance.users++ > 0) return { status: 409, json: { error: 'already_bootstrapped' } };
        const db = [...databases.values()][0];
        if (db) db.content += ' user';
        return { status: 201, json: { ok: true, inviteUrl: 'https://agence-nord.crm-agence.fr/reset-password?token=TOKEN123&email=x', expiresAt: '2099-10-27T10:00:00Z' } };
      }
      if (path === '/api/instance/license') {
        Object.assign(instance.license, json);
        calls.push(`license:${JSON.stringify(json)}`);
        return { status: 200, json: { ok: true, license: instance.license, seats: { used: instance.users, limit: instance.license.seatLimit } } };
      }
      if (path === '/api/instance/integrations' && method === 'GET') {
        const keys = INTEGRATION_KEY_NAMES.map((name) => ({
          name,
          label: name,
          group: name.startsWith('ALLO') ? 'telephony' : name === 'OPENAI_API_KEY' || name === 'GEMINI_API_KEY' ? 'ai' : 'data',
          groupLabel: 'Groupe',
          usedFor: 'usage',
          placeholder: null,
          docsUrl: null,
          source: instance.keys.has(name) ? 'stored' : instance.envKeys.has(name) ? 'env' : 'none',
          hint: instance.keys.has(name) ? '••••' : null,
          updatedAt: null,
          updatedBy: null,
        }));
        return { status: 200, json: { ok: true, keys } };
      }
      if (path === '/api/instance/integrations' && method === 'PUT') {
        const errors: Record<string, string> = {};
        for (const [k, v] of Object.entries(json.values as Record<string, string | null>)) {
          if (v === null) instance.keys.delete(k);
          else if (/\s/.test(v)) errors[k] = 'espace';
          else instance.keys.set(k, v);
        }
        if (Object.keys(errors).length) return { status: 422, json: { ok: false, error: 'validation_failed', errors } };
        calls.push(`keys:${Object.keys(json.values).join(',')}`);
        return { status: 200, json: { ok: true } };
      }
      if (path === '/api/instance/cron' && method === 'GET') {
        return { status: 200, json: { ok: true, jobs: [{ id: 'messaging-outbox', schedule: '* * * * *' }, { id: 'exclusion-sweep', schedule: '0 4 * * *' }] } };
      }
      if (path === '/api/instance/cron' && method === 'POST') {
        instance.cronCalls.push(json.job);
        if (instance.cronFails.has(json.job)) return { status: 502, json: { ok: false, job: json.job, status: 500 } };
        return { status: 200, json: { ok: true, job: json.job, status: 200 } };
      }
      if (path === '/api/instance/export' && method === 'POST') {
        instance.exports.set('exp-1', 0);
        return { status: 202, json: { ok: true, export: { id: 'exp-1', state: 'running' } } };
      }
      if (path.startsWith('/api/instance/export?id=')) {
        const n = (instance.exports.get('exp-1') ?? 0) + 1;
        instance.exports.set('exp-1', n);
        return n < 2
          ? { status: 200, json: { ok: true, export: { id: 'exp-1', state: 'running' }, downloadUrl: null } }
          : { status: 200, json: { ok: true, export: { id: 'exp-1', state: 'done' }, downloadUrl: 'https://minio.example/exports/exp-1.zip?sig' } };
      }
      return { status: 200, json: { ok: true } };
    },
    dns: { resolveCname: async () => [] },
    proxy: {
      writeRoute: async (slug, content) => (routes.set(slug, content), `/dyn/agency-${slug}.yml`),
      removeRoute: async (slug) => void routes.delete(slug),
    },
    download: async (url) => Readable.from([Buffer.from(`ZIP(${url})`)]),
    notify: {
      alert: async (subject) => (alerts.push(subject), true),
      invite: async (i) => (invites.push({ to: i.to, url: i.url }), true),
    },
    sleep: async (ms) => void (clock += ms),
    now: () => new Date(clock),
  };

  return {
    infra,
    calls,
    databases,
    roles,
    buckets,
    objects,
    offsiteObjects,
    offsiteState,
    apps,
    routes,
    instance,
    invites,
    alerts,
    advance: (ms: number) => void (clock += ms),
    setTime: (iso: string) => void (clock = Date.parse(iso)),
  };
}
