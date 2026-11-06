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

// ---------- the CRM's support API (/api/instance/support/*), one ticket store per agency host ----------

export type FakeTicket = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  category: string;
  scope: string;
  priority: string;
  status: string;
  validation: string;
  requester: { name: string; role: string };
  createdAt: string;
  updatedAt: string;
  dueDate: string | null;
  thread: { kind: 'comment' | 'event'; id: string; at: string; author: { name: string; role: string; platform: boolean }; content?: string; field?: string; from?: string | null; to?: string | null }[];
};

export type FakeSupport = { tickets: FakeTicket[]; down: boolean; missing: boolean; queries: string[]; posts: unknown[] };

const TRANSITIONS: Record<string, string[]> = {
  NEW: ['TODO', 'IN_PROGRESS'],
  TODO: ['NEW', 'IN_PROGRESS'],
  IN_PROGRESS: ['TODO', 'BLOCKED', 'TESTING'],
  BLOCKED: ['TODO', 'IN_PROGRESS'],
  TESTING: ['IN_PROGRESS', 'BLOCKED', 'COMPLETED'],
  COMPLETED: ['IN_PROGRESS'],
};

function summary(t: FakeTicket, now: number) {
  return {
    id: t.id,
    number: t.number,
    ref: `#TC-${String(t.number).padStart(4, '0')}`,
    title: t.title,
    preview: t.description,
    category: t.category,
    scope: t.scope,
    priority: t.priority,
    status: t.status,
    validation: t.validation,
    dueDate: t.dueDate,
    overdue: Boolean(t.dueDate && t.status !== 'COMPLETED' && Date.parse(t.dueDate) < now),
    completedAt: t.status === 'COMPLETED' ? t.updatedAt : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    requester: t.requester,
    assignee: null,
    client: null,
    comments: t.thread.filter((i) => i.kind === 'comment').length,
    attachments: 0,
    lastPlatformReplyAt: t.thread.filter((i) => i.kind === 'comment' && i.author.platform).map((i) => i.at).sort().pop() ?? null,
  };
}

function supportApi(store: FakeSupport, method: string, path: string, json: any, now: () => number): { status: number; json: unknown } {
  if (store.missing) return { status: 404, json: 'Not Found' };
  const url = new URL(path, 'https://x');
  const iso = new Date(now()).toISOString();
  if (url.pathname === '/api/instance/support/tickets' && method === 'GET') {
    store.queries.push(url.search);
    const since = url.searchParams.get('updatedSince');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const all = [...store.tickets].filter((t) => !since || Date.parse(t.updatedAt) >= Date.parse(since)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const page = all.slice(offset, offset + limit);
    const open = store.tickets.filter((t) => t.status !== 'COMPLETED');
    return {
      status: 200,
      json: {
        ok: true,
        tickets: page.map((t) => summary(t, now())),
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
        counts: { open: open.length, new: open.filter((t) => t.status === 'NEW').length, urgent: open.filter((t) => t.priority === 'URGENT').length, blocked: 0, active: 0, overdue: 0, pendingValidation: 0, unassigned: open.length },
        serverTime: iso,
      },
    };
  }
  const m = /^\/api\/instance\/support\/tickets\/([^/]+)$/.exec(url.pathname);
  const t = m ? store.tickets.find((x) => x.id === m[1]) : undefined;
  if (m && !t) return { status: 404, json: { ok: false, error: 'ticket_not_found' } };
  if (!t) return { status: 404, json: 'Not Found' };
  const detail = () => ({ ok: true, ticket: { ...summary(t, now()), description: t.description, mission: null, attachments: [], releaseChecks: [], allowedStatuses: TRANSITIONS[t.status] ?? [], thread: t.thread } });
  if (method === 'GET') return { status: 200, json: detail() };
  store.posts.push(json);
  const platform = { name: 'Support plateforme', role: 'DEVELOPER', platform: true };
  const sign = (c: string) => (json.operator ? `${c}\n\n— ${json.operator}, Support plateforme` : c);
  if (json.action === 'comment') {
    t.thread.push({ kind: 'comment', id: `c${t.thread.length + 1}`, at: iso, author: platform, content: sign(json.content) });
  } else if (json.action === 'status') {
    if (!(TRANSITIONS[t.status] ?? []).includes(json.status)) {
      return { status: 422, json: { ok: false, error: 'rule_violation', message: `Transition de statut invalide : ${t.status} → ${json.status}` } };
    }
    t.thread.push({ kind: 'event', id: `e${t.thread.length + 1}`, at: iso, author: platform, field: 'status', from: t.status, to: json.status });
    t.status = json.status;
    if (json.comment) t.thread.push({ kind: 'comment', id: `c${t.thread.length + 1}`, at: iso, author: platform, content: sign(json.comment) });
  } else if (json.action === 'priority') {
    t.thread.push({ kind: 'event', id: `e${t.thread.length + 1}`, at: iso, author: platform, field: 'priority', from: t.priority, to: json.priority });
    t.priority = json.priority;
  }
  t.updatedAt = iso;
  return { status: 200, json: detail() };
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
  /** Support Technique tickets of each agency CRM, by host (e.g. agence-nord.crm-agence.fr). */
  const support = new Map<string, FakeSupport>();
  const supportFor = (host: string) => {
    if (!support.has(host)) support.set(host, { tickets: [], down: false, missing: false, queries: [], posts: [] });
    return support.get(host)!;
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
      if (path.startsWith('/api/instance/support/')) {
        const store = supportFor(new URL(_base).host);
        if (store.down) throw new Error('connect ECONNREFUSED');
        return supportApi(store, method, path, typeof body === 'string' && body ? JSON.parse(body) : undefined, () => clock);
      }
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
    support,
    supportFor,
    invites,
    alerts,
    advance: (ms: number) => void (clock += ms),
    setTime: (iso: string) => void (clock = Date.parse(iso)),
  };
}
