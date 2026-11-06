// What every part of the Console shares: the database, the servers, the sealer and the
// settings derived from the environment.

import type { Config } from './config.ts';
import type { Sealer } from './crypto.ts';
import type { Sql } from './db.ts';
import type { DbTarget, Infra } from './infra/types.ts';
import { PROTECTED_KEYS, type MinioTarget, type PgTarget } from './provision/plan.ts';

export type Settings = {
  platformDomain: string;
  /** Postgres as the agency containers see it (goes into DATABASE_URL). */
  pg: PgTarget;
  /** Postgres as the Console sees it (pg_dump, pg_restore): the admin URL's host. */
  pgFromConsole: { host: string; port: number; params?: string };
  minio: MinioTarget;
  shared: Record<string, string>;
  imageRepo: string;
  defaultTag: string;
  dokployProject: string;
  dokployEnvironmentId?: string;
  registry?: { username: string; password: string; url: string };
  retentionDays: number;
  backupHourUtc: number;
  drillDay: number;
  healthFailuresBeforeAlert: number;
  centralCron: boolean;
  consoleUrl: string;
  /** The Console's own database, for its nightly self-backup (from DATABASE_URL). */
  consoleDb?: DbTarget;
  /** Tests: reach every instance at this base URL instead of https://<host>. */
  baseUrlOverride?: string;
  /** Tests: shorter health waits. */
  healthTimeoutMs?: number;
};

/** backupKey: encrypts backups and exports (src/backup-crypto.ts); absent only in tests that don't care. */
export type Platform = { sql: Sql; infra: Infra; sealer: Sealer; settings: Settings; backupKey?: Buffer };

export function dbTargetFromUrl(url: string): DbTarget {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    params: u.search.replace(/^\?/, '') || undefined,
  };
}

export function settingsFromConfig(config: Config, shared: Record<string, string>): Settings {
  const admin = new URL(config.PROVISION_PG_ADMIN_URL);
  const adminPort = Number(admin.port || 5432);
  return {
    platformDomain: config.PROVISION_PLATFORM_DOMAIN,
    pg: { host: config.PROVISION_PG_APP_HOST ?? admin.hostname, port: Number(config.PROVISION_PG_APP_PORT ?? adminPort), params: config.PROVISION_PG_PARAMS },
    pgFromConsole: { host: admin.hostname, port: adminPort, params: config.PROVISION_PG_PARAMS },
    minio: {
      endpoint: config.PROVISION_MINIO_ENDPOINT,
      accessKeyId: config.PROVISION_MINIO_ACCESS_KEY_ID,
      secretAccessKey: config.PROVISION_MINIO_SECRET_ACCESS_KEY,
      region: config.PROVISION_MINIO_REGION,
    },
    // Per-agency keys (database, secrets, URL, bucket) can never come from the shared file.
    shared: Object.fromEntries(Object.entries(shared).filter(([k]) => !(PROTECTED_KEYS as readonly string[]).includes(k))),
    imageRepo: config.PROVISION_IMAGE_REPO,
    defaultTag: config.PROVISION_DEFAULT_TAG,
    dokployProject: config.PROVISION_DOKPLOY_PROJECT,
    dokployEnvironmentId: config.PROVISION_DOKPLOY_ENVIRONMENT_ID,
    registry:
      config.PROVISION_REGISTRY_USER && config.PROVISION_REGISTRY_TOKEN
        ? { username: config.PROVISION_REGISTRY_USER, password: config.PROVISION_REGISTRY_TOKEN, url: 'ghcr.io' }
        : undefined,
    retentionDays: config.BACKUP_RETENTION_DAYS,
    backupHourUtc: config.BACKUP_HOUR_UTC,
    drillDay: config.RESTORE_DRILL_DAY,
    healthFailuresBeforeAlert: config.HEALTH_FAILURES_BEFORE_ALERT,
    centralCron: config.CENTRAL_CRON,
    consoleUrl: config.CONSOLE_URL.replace(/\/+$/, ''),
    consoleDb: dbTargetFromUrl(config.DATABASE_URL),
  };
}
