-- Wave 0 of docs/DEEP_CONTROL_PLAN.md: operator roles, fleet rollouts, encrypted and off-site
-- backups, the Console's own backups.

-- ---------- operator roles ----------
-- owner (Propriétaire) | operator (Opérateur) | support | viewer (Lecture). See src/roles.ts.
ALTER TABLE operators ADD COLUMN role text NOT NULL DEFAULT 'operator'
  CHECK (role IN ('owner', 'operator', 'support', 'viewer'));
-- The first account ever created (the one made with `npm run operator:create` on the server)
-- becomes the owner; `npm run operator:role` changes it afterwards.
UPDATE operators SET role = 'owner'
WHERE id = (SELECT id FROM operators ORDER BY created_at LIMIT 1);

-- ---------- fleet rollouts: one agency at a time, stop at the first failure ----------
CREATE TABLE rollouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag            text NOT NULL,
  -- upgrade order; position = index of the agency being upgraded
  agency_ids     uuid[] NOT NULL,
  position       int NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'stopped')),
  current_job_id uuid REFERENCES jobs(id),
  error          text,
  created_by     uuid REFERENCES operators(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE UNIQUE INDEX rollouts_one_running ON rollouts ((true)) WHERE status = 'running';

-- ---------- encrypted backups and their off-site copy ----------
-- encrypted: the object is the self-describing format of src/backup-crypto.ts (decryptable with
-- CONSOLE_ENCRYPTION_KEY alone, even without this database).
ALTER TABLE backups ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE backups ADD COLUMN offsite_at timestamptz;
ALTER TABLE backups ADD COLUMN offsite_error text;
ALTER TABLE exports ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE exports ADD COLUMN offsite_at timestamptz;
ALTER TABLE exports ADD COLUMN offsite_error text;

-- ---------- the Console's own database ----------
CREATE TABLE console_backups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- nightly | manual
  reason        text NOT NULL,
  object_key    text NOT NULL,
  size_bytes    bigint NOT NULL,
  encrypted     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  offsite_at    timestamptz,
  offsite_error text,
  removed_at    timestamptz
);
CREATE INDEX console_backups_created ON console_backups (created_at DESC);

CREATE INDEX audit_log_agency_at ON audit_log (agency_id, at DESC);
CREATE INDEX audit_log_operator_at ON audit_log (operator_id, at DESC);
