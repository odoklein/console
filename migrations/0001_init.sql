-- Console schema. One row per agency; its provisioning state (secrets included) is
-- stored encrypted (AES-256-GCM, CONSOLE_ENCRYPTION_KEY) in agencies.state_enc.

CREATE TABLE operators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text,                 -- null until the operator sets one (setup link)
  setup_token_hash text,
  setup_expires_at timestamptz,
  totp_secret_enc text,               -- set at first login, required afterwards
  totp_enabled  boolean NOT NULL DEFAULT false,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE operator_sessions (
  token_hash   text PRIMARY KEY,
  operator_id  uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  -- false between the password and the TOTP code
  verified     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX operator_sessions_operator ON operator_sessions (operator_id);

CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  ip         text,
  ok         boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_at ON login_attempts (email, at DESC);

CREATE TABLE agencies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  -- AgencyConfig (src/provision/plan.ts) without logos; pack and billing contact live here too
  config          jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'provisioning'
                  CHECK (status IN ('provisioning', 'active', 'failed', 'suspended', 'deleting', 'deleted')),
  primary_host    text NOT NULL,
  domains         text[] NOT NULL DEFAULT '{}',
  domain_pending  boolean NOT NULL DEFAULT false,
  image_tag       text,
  state_enc       text,               -- encrypted provisioning State (secrets)
  -- last health probe
  health          jsonb,
  health_ok       boolean,
  health_checked_at timestamptz,
  health_failures int NOT NULL DEFAULT 0,
  storage_bytes   bigint,
  storage_checked_at timestamptz,
  last_backup_at  timestamptz,
  created_by      uuid REFERENCES operators(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE agency_logos (
  agency_id    uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  slot         text NOT NULL,
  filename     text NOT NULL,
  content_type text NOT NULL,
  data         bytea NOT NULL,
  PRIMARY KEY (agency_id, slot)
);

-- Postgres as the job queue: SKIP LOCKED claims, one running job per agency.
CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL REFERENCES agencies(id),
  kind         text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  -- [{ id, label, result: todo|running|done|pending|skipped|failed, note?, at? }]
  steps        jsonb NOT NULL DEFAULT '[]',
  result       jsonb,
  secret_enc   text,                -- encrypted one-time output (the manager invite link)
  error        text,
  attempts     int NOT NULL DEFAULT 0,
  run_after    timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES operators(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX jobs_queue ON jobs (run_after) WHERE status = 'queued';
CREATE INDEX jobs_agency ON jobs (agency_id, created_at DESC);

CREATE TABLE job_logs (
  id      bigserial PRIMARY KEY,
  job_id  uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  line    text NOT NULL
);
CREATE INDEX job_logs_job ON job_logs (job_id, id);

CREATE TABLE backups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL REFERENCES agencies(id),
  -- nightly | manual | pre-upgrade | pre-restore | final (before deletion)
  reason       text NOT NULL,
  object_key   text NOT NULL,
  size_bytes   bigint NOT NULL,
  image_tag    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  verified_at  timestamptz,         -- last successful restore drill of this backup
  verify_note  text,
  removed_at   timestamptz
);
CREATE INDEX backups_agency ON backups (agency_id, created_at DESC);

-- Data exports (POST /api/instance/export), copied into the platform bucket so they survive the agency.
CREATE TABLE exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL REFERENCES agencies(id),
  job_id       uuid REFERENCES jobs(id),
  object_key   text NOT NULL,
  size_bytes   bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid REFERENCES agencies(id),
  -- health | cron | backup | job | drill
  kind         text NOT NULL,
  -- de-duplication: one open alert per (agency, key)
  key          text NOT NULL,
  message      text NOT NULL,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  notified_at  timestamptz,
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX alerts_open ON alerts (coalesce(agency_id, '00000000-0000-0000-0000-000000000000'::uuid), key) WHERE resolved_at IS NULL;

-- Central scheduler: each instance's /api/instance/cron catalog and the last run of each job.
CREATE TABLE agency_cron (
  agency_id    uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  job_id       text NOT NULL,
  schedule     text NOT NULL,
  description  text,
  last_run_at  timestamptz,
  last_ok      boolean,
  last_status  int,
  last_error   text,
  failures     int NOT NULL DEFAULT 0,
  PRIMARY KEY (agency_id, job_id)
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  operator_id  uuid REFERENCES operators(id),
  agency_id    uuid REFERENCES agencies(id),
  action       text NOT NULL,
  detail       jsonb,
  ip           text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- Scheduler bookkeeping ("nightly backups ran for 2026-10-26").
CREATE TABLE scheduler_marks (
  name   text PRIMARY KEY,
  value  text NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
