import { z } from 'zod';

// Every setting comes from the environment (Dokploy: the app's "Environment" tab).
// The PROVISION_* names are those of scripts/provision-agency in the CRM repo, so one
// infra file serves both the CLI and the Console.
const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const Env = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  MIGRATE_ON_BOOT: z.stringbool().default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Public address of the Console (cookies, links in emails). */
  CONSOLE_URL: z.string().url().default('http://localhost:3100'),
  /** 64 hex chars. Encrypts agency secrets and invite links at rest. */
  CONSOLE_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, '64 hex characters (openssl rand -hex 32)'),
  /** all = HTTP + job worker + scheduler; api = HTTP only. */
  ROLE: z.enum(['all', 'api']).default('all'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),

  // ---- where agencies live (same names as provision.infra.env) ----
  PROVISION_PLATFORM_DOMAIN: z.string().trim().min(3),
  PROVISION_PG_ADMIN_URL: z.string().regex(/^postgres(ql)?:\/\//),
  PROVISION_PG_APP_HOST: optional,
  PROVISION_PG_APP_PORT: optional,
  PROVISION_PG_PARAMS: optional,
  PROVISION_MINIO_ENDPOINT: z.string().url(),
  PROVISION_MINIO_ACCESS_KEY_ID: z.string().min(3),
  PROVISION_MINIO_SECRET_ACCESS_KEY: z.string().min(3),
  PROVISION_MINIO_REGION: optional,
  PROVISION_MINIO_MC_ALIAS: optional,
  PROVISION_DOKPLOY_URL: z.string().url(),
  PROVISION_DOKPLOY_API_KEY: z.string().min(8),
  PROVISION_DOKPLOY_PROJECT: z.string().default('agencies'),
  PROVISION_DOKPLOY_ENVIRONMENT_ID: optional,
  PROVISION_IMAGE_REPO: z.string().default('ghcr.io/odoklein/captainprospect-crm'),
  /** Tag a new agency starts on (a release tag, never :main). */
  PROVISION_DEFAULT_TAG: z.string().trim().min(1),
  PROVISION_REGISTRY_USER: optional,
  PROVISION_REGISTRY_TOKEN: optional,
  PROVISION_DOCKER_NETWORK: optional,
  PROVISION_PROXY_DYNAMIC_DIR: optional,
  /** KEY=VALUE file copied into every agency (SMTP, AI keys, OAuth apps, relay, socket). */
  PROVISION_SHARED_ENV: optional,

  // ---- backups ----
  /** Bucket for database dumps and final exports. A different S3 endpoint (another region) is recommended. */
  BACKUP_BUCKET: z.string().default('console-backups'),
  BACKUP_S3_ENDPOINT: optional,
  BACKUP_S3_ACCESS_KEY_ID: optional,
  BACKUP_S3_SECRET_ACCESS_KEY: optional,
  BACKUP_S3_REGION: optional,
  // Off-site copy of every encrypted backup and export (Backblaze B2, EU). The bucket must exist;
  // the key can be limited to it. Empty = no off-site copy.
  OFFSITE_S3_ENDPOINT: optional,
  OFFSITE_S3_BUCKET: optional,
  OFFSITE_S3_ACCESS_KEY_ID: optional,
  OFFSITE_S3_SECRET_ACCESS_KEY: optional,
  OFFSITE_S3_REGION: optional,
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** UTC hour of the nightly backups. */
  BACKUP_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(2),
  /** Day of the month of the restore drill (each agency's latest backup). */
  RESTORE_DRILL_DAY: z.coerce.number().int().min(1).max(28).default(1),

  // ---- alerts and emails ----
  ALERT_EMAIL_TO: optional,
  ALERT_SLACK_WEBHOOK_URL: optional,
  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: optional,
  /** Consecutive failed health probes (one a minute) before an alert. */
  HEALTH_FAILURES_BEFORE_ALERT: z.coerce.number().int().min(1).max(60).default(3),
  /** Central cron scheduler (calls each instance's /api/instance/cron). */
  CENTRAL_CRON: z.stringbool().default(true),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
