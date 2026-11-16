-- Support inbox: the Support Technique tickets of every agency CRM in one place.
-- The CRM stays the source of truth (GET/POST /api/instance/support/*); these tables are the
-- Console's cache, what each operator has read, and the team's canned replies.

-- One row per ticket of one agency, refreshed by the scheduler (src/support.ts).
CREATE TABLE support_tickets (
  agency_id       uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  ticket_id       text NOT NULL,
  number          int NOT NULL,
  ref             text NOT NULL,
  title           text NOT NULL,
  preview         text,
  category        text NOT NULL,
  scope           text NOT NULL,
  priority        text NOT NULL,
  status          text NOT NULL,
  validation      text NOT NULL,
  requester_name  text,
  requester_role  text,
  assignee_name   text,
  client_name     text,
  comments        int NOT NULL DEFAULT 0,
  attachments     int NOT NULL DEFAULT 0,
  due_date        timestamptz,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  -- last message the platform team sent on this ticket (from the Console or seen in its thread)
  last_platform_reply_at timestamptz,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, ticket_id)
);
CREATE INDEX support_tickets_updated ON support_tickets (updated_at DESC);
CREATE INDEX support_tickets_open ON support_tickets (status, priority) WHERE status <> 'COMPLETED';

-- Sync bookkeeping per agency: incremental cursor, the instance's own counters, the last error.
CREATE TABLE support_sync (
  agency_id       uuid PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
  -- the instance's serverTime at the last good pass: next pass asks updatedSince=cursor
  cursor          timestamptz,
  counts          jsonb,
  synced_at       timestamptz,
  full_synced_at  timestamptz,
  error           text,
  error_at        timestamptz
);

-- "Non lu": the ticket changed after this operator last opened it.
CREATE TABLE support_reads (
  operator_id     uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  agency_id       uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  ticket_id       text NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, agency_id, ticket_id)
);

-- Réponses types: canned replies the whole team shares.
CREATE TABLE support_macros (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  body            text NOT NULL,
  created_by      uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
