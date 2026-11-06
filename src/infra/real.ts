// Real servers: Postgres cluster (postgres.js, admin URL), MinIO/S3, `mc`, `docker`,
// `pg_dump`/`pg_restore`, Dokploy, the public proxy's dynamic directory, SMTP, Slack.
// The Docker image ships pg client tools, docker-cli and mc (see Dockerfile).

import { spawn } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import nodemailer from 'nodemailer';
import postgres from 'postgres';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { DokployClient } from '../provision/dokploy.ts';
import { signInstanceRequest } from '../provision/instance-auth.ts';
import type { DbTarget, Infra, Notifier } from './types.ts';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe_identifier:${name}`);
  return `"${name}"`;
}

function literal(pw: string): string {
  if (!SAFE_PASSWORD.test(pw)) throw new Error('unsafe_password');
  return `'${pw}'`;
}

function exec(cmd: string, args: string[], opts: { env?: Record<string, string>; stdin?: Readable; stdout?: 'pipe' | 'inherit' } = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: [opts.stdin ? 'pipe' : 'ignore', opts.stdout ?? 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  if (opts.stdin && child.stdin) opts.stdin.pipe(child.stdin);
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0] ?? ''} a échoué (code ${code}): ${stderr.trim().slice(-600)}`))));
  });
  return { child, done };
}

// ---------- Postgres ----------

function realPg(adminUrl: string): Infra['pg'] {
  const admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
  const exists = async (query: string, name: string) => (await admin.unsafe(query, [name])).length > 0;
  return {
    roleExists: (r) => exists('SELECT 1 FROM pg_roles WHERE rolname = $1', r),
    databaseExists: (n) => exists('SELECT 1 FROM pg_database WHERE datname = $1', n),
    async createRole(role, password) {
      await admin.unsafe(`CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)}`);
    },
    async setRolePassword(role, password) {
      await admin.unsafe(`ALTER ROLE ${ident(role)} PASSWORD ${literal(password)}`);
    },
    async createDatabase(db, owner) {
      await admin.unsafe(`CREATE DATABASE ${ident(db)} OWNER ${ident(owner)}`);
    },
    async dropDatabase(db) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(db)} WITH (FORCE)`);
    },
    async dropRole(role) {
      await admin.unsafe(`DROP ROLE IF EXISTS ${ident(role)}`);
    },
    async scalar(db, query) {
      const url = new URL(adminUrl);
      url.pathname = `/${db}`;
      const one = postgres(url.toString(), { max: 1, onnotice: () => {} });
      try {
        const rows = await one.unsafe(query);
        const first = rows[0] as Record<string, unknown> | undefined;
        const v = first ? Object.values(first)[0] : null;
        return v == null ? null : String(v);
      } finally {
        await one.end({ timeout: 2 });
      }
    },
  };
}

function realDumper(): Infra['dumper'] {
  const env = (t: DbTarget) => ({ PGHOST: t.host, PGPORT: String(t.port), PGDATABASE: t.database, PGUSER: t.user, PGPASSWORD: t.password, ...(t.params?.includes('sslmode=require') ? { PGSSLMODE: 'require' } : {}) });
  return {
    dump(t) {
      const { child, done } = exec('pg_dump', ['--format=custom', '--no-owner', '--no-acl'], { env: env(t) });
      return { stream: child.stdout as Readable, done };
    },
    async restore(t, input, opts) {
      const args = ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', t.database];
      if (opts.clean) args.push('--clean', '--if-exists');
      await exec('pg_restore', args, { env: env(t), stdin: input }).done;
    },
  };
}

// ---------- S3 / MinIO ----------

type S3Target = { endpoint: string; accessKeyId: string; secretAccessKey: string; region?: string };

function s3(t: S3Target): S3Client {
  return new S3Client({ endpoint: t.endpoint, region: t.region ?? 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey } });
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404 && (err as { name?: string }).name !== 'NotFound') throw err;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function* listKeys(client: S3Client, bucket: string) {
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) yield { key: o.Key, size: o.Size ?? 0 };
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

function runMc(args: string[]): Promise<void> {
  return exec('mc', args).done;
}

function realStorage(target: S3Target, mcAlias?: string): Infra['storage'] {
  const client = s3(target);
  const storage: Infra['storage'] = {
    ensureBucket: (bucket) => ensureBucket(client, bucket),
    async bucketSize(bucket) {
      let total = 0;
      for await (const o of listKeys(client, bucket)) total += o.size;
      return total;
    },
    async removeBucket(bucket) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        return; // already gone
      }
      let batch: { Key: string }[] = [];
      const flush = async () => {
        if (batch.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
        batch = [];
      };
      for await (const o of listKeys(client, bucket)) {
        batch.push({ Key: o.key });
        if (batch.length === 1000) await flush();
      }
      await flush();
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    },
  };
  if (mcAlias) {
    storage.scopedKey = async (bucket, accessKeyId, secretAccessKey) => {
      const policy = `agency-${bucket}`;
      const doc = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['s3:*'], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`] }],
      });
      const dir = path.join(tmpdir(), 'console-mc');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${policy}.policy.json`);
      await writeFile(file, doc);
      try {
        // `user add` on an existing user resets its secret, `policy create` overwrites: safe to repeat.
        await runMc(['admin', 'user', 'add', mcAlias, accessKeyId, secretAccessKey]);
        await runMc(['admin', 'policy', 'create', mcAlias, policy, file]);
        await runMc(['admin', 'policy', 'attach', mcAlias, policy, '--user', accessKeyId]).catch(() => undefined); // already attached
      } finally {
        await rm(file, { force: true });
      }
    };
    storage.removeKey = async (accessKeyId) => {
      await runMc(['admin', 'user', 'remove', mcAlias, accessKeyId]).catch(() => undefined); // already removed
    };
  }
  return storage;
}

function realBackups(target: S3Target, bucket: string): Infra['backups'] {
  const client = s3(target);
  let ready: Promise<void> | null = null;
  const ensure = () => (ready ??= ensureBucket(client, bucket).catch((err) => {
    ready = null;
    throw err;
  }));
  return {
    async put(key, body, contentType = 'application/octet-stream') {
      await ensure();
      let size = 0;
      const counted = new PassThrough();
      counted.on('data', (c: Buffer) => {
        size += c.length;
      });
      (body instanceof Uint8Array ? Readable.from([Buffer.from(body)]) : body).pipe(counted);
      await new Upload({ client, params: { Bucket: bucket, Key: key, Body: counted, ContentType: contentType } }).done();
      return size;
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body as Readable;
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    url: (key, filename) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/[^\w.\-]/g, '_')}"` }), { expiresIn: 900 }),
  };
}

function realOffsite(target: S3Target, bucket: string): NonNullable<Infra['offsite']> {
  const client = s3(target);
  return {
    label: `${new URL(target.endpoint).host}/${bucket}`,
    // No ensureBucket: the bucket is created by hand and the key may be limited to it.
    async put(key, body) {
      let size = 0;
      const counted = new PassThrough();
      counted.on('data', (c: Buffer) => {
        size += c.length;
      });
      body.pipe(counted);
      await new Upload({ client, params: { Bucket: bucket, Key: key, Body: counted, ContentType: 'application/octet-stream' } }).done();
      return size;
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

// ---------- docker (migrate image) ----------

function realDbJob(dockerNetwork?: string): Infra['runDbJob'] {
  return async (job, input) => {
    const args = ['run', '--rm', ...(dockerNetwork ? ['--network', dockerNetwork] : []), '-e', 'DATABASE_URL', '-e', 'DIRECT_URL', input.image];
    if (job === 'seed') args.push('npm', 'run', 'db:seed:instance');
    await exec('docker', args, { env: { DATABASE_URL: input.databaseUrl, DIRECT_URL: input.directUrl } }).done;
  };
}

// ---------- the agency instance (signed /api/instance/*) ----------

function realInstance(): Infra['instance'] {
  return (baseUrl, secret) => async (method, pathWithQuery, body, headers = {}) => {
    const sig = signInstanceRequest({ secret, method, pathWithQuery, body });
    const res = await fetch(baseUrl.replace(/\/+$/, '') + pathWithQuery, {
      method,
      body: body as string | Uint8Array<ArrayBuffer> | undefined,
      headers: { ...headers, ...sig },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  };
}

// ---------- public proxy ----------

function realProxy(dir: string): NonNullable<Infra['proxy']> {
  const file = (slug: string) => path.join(dir, `agency-${slug}.yml`);
  return {
    async writeRoute(slug, content) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(slug), content, { mode: 0o644 });
      return file(slug);
    },
    async removeRoute(slug) {
      await rm(file(slug), { force: true });
    },
  };
}

// ---------- notifications ----------

export function realNotifier(config: Config): Notifier {
  const mailer = config.SMTP_HOST
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } : undefined,
      })
    : null;
  const from = config.SMTP_FROM ?? config.SMTP_USER ?? `console@${config.PROVISION_PLATFORM_DOMAIN}`;
  return {
    async alert(subject, text) {
      let sent = false;
      if (config.ALERT_SLACK_WEBHOOK_URL) {
        try {
          const res = await fetch(config.ALERT_SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: `*${subject}*\n${text}` }),
            signal: AbortSignal.timeout(10_000),
          });
          sent ||= res.ok;
        } catch (err) {
          log.warn('alert.slack_failed', { error: String(err) });
        }
      }
      if (mailer && config.ALERT_EMAIL_TO) {
        try {
          await mailer.sendMail({ from, to: config.ALERT_EMAIL_TO, subject: `[Console] ${subject}`, text: `${text}\n\n${config.CONSOLE_URL}/alerts` });
          sent = true;
        } catch (err) {
          log.warn('alert.email_failed', { error: String(err) });
        }
      }
      return sent;
    },
    async invite({ to, name, agencyName, url, expiresAt }) {
      if (!mailer) return false;
      const until = expiresAt ? new Date(expiresAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : 'dans 24 heures';
      await mailer.sendMail({
        from: `${agencyName} <${from}>`,
        to,
        subject: `Votre espace ${agencyName} est prêt`,
        text: [
          `Bonjour ${name},`,
          '',
          `Le CRM de ${agencyName} est prêt. Choisissez votre mot de passe pour activer votre compte manager :`,
          url,
          '',
          `Ce lien est valable jusqu'au ${until}. Passé ce délai, utilisez « Mot de passe oublié » sur la page de connexion.`,
        ].join('\n'),
      });
      return true;
    },
  };
}

// ---------- assembly ----------

export function realInfra(config: Config): Infra {
  const minio: S3Target = {
    endpoint: config.PROVISION_MINIO_ENDPOINT,
    accessKeyId: config.PROVISION_MINIO_ACCESS_KEY_ID,
    secretAccessKey: config.PROVISION_MINIO_SECRET_ACCESS_KEY,
    region: config.PROVISION_MINIO_REGION,
  };
  const backupTarget: S3Target = config.BACKUP_S3_ENDPOINT
    ? { endpoint: config.BACKUP_S3_ENDPOINT, accessKeyId: config.BACKUP_S3_ACCESS_KEY_ID ?? '', secretAccessKey: config.BACKUP_S3_SECRET_ACCESS_KEY ?? '', region: config.BACKUP_S3_REGION }
    : minio;
  return {
    pg: realPg(config.PROVISION_PG_ADMIN_URL),
    storage: realStorage(minio, config.PROVISION_MINIO_MC_ALIAS),
    backups: realBackups(backupTarget, config.BACKUP_BUCKET),
    offsite:
      config.OFFSITE_S3_ENDPOINT && config.OFFSITE_S3_BUCKET && config.OFFSITE_S3_ACCESS_KEY_ID && config.OFFSITE_S3_SECRET_ACCESS_KEY
        ? realOffsite(
            { endpoint: config.OFFSITE_S3_ENDPOINT, accessKeyId: config.OFFSITE_S3_ACCESS_KEY_ID, secretAccessKey: config.OFFSITE_S3_SECRET_ACCESS_KEY, region: config.OFFSITE_S3_REGION },
            config.OFFSITE_S3_BUCKET,
          )
        : undefined,
    dumper: realDumper(),
    runDbJob: realDbJob(config.PROVISION_DOCKER_NETWORK),
    dokploy: new DokployClient(config.PROVISION_DOKPLOY_URL, config.PROVISION_DOKPLOY_API_KEY),
    instance: realInstance(),
    dns: { resolveCname: (host) => dns.resolveCname(host), resolve4: (host) => dns.resolve4(host) },
    proxy: config.PROVISION_PROXY_DYNAMIC_DIR ? realProxy(config.PROVISION_PROXY_DYNAMIC_DIR) : undefined,
    async download(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`téléchargement impossible: HTTP ${res.status}`);
      return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    },
    notify: realNotifier(config),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}

/** Registers the mc alias from the MinIO admin credentials (idempotent), so scoped keys work in a fresh container. */
export async function configureMcAlias(config: Config): Promise<void> {
  if (!config.PROVISION_MINIO_MC_ALIAS) return;
  await runMc(['alias', 'set', config.PROVISION_MINIO_MC_ALIAS, config.PROVISION_MINIO_ENDPOINT, config.PROVISION_MINIO_ACCESS_KEY_ID, config.PROVISION_MINIO_SECRET_ACCESS_KEY]).catch((err) =>
    log.warn('mc.alias_failed', { error: String(err) }),
  );
}
