-- "Nouveautés": releases (a CRM image tag plus its edited notes), standalone announcements, and
-- the per-agency delivery of both to the instance (PUT /api/instance/changelog).

CREATE TABLE releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag           text NOT NULL UNIQUE,
  title         text NOT NULL DEFAULT '',
  channel       text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  -- [{ type: 'new'|'improved'|'fixed', title, body, module? }]
  notes         jsonb NOT NULL DEFAULT '[]',
  from_tag      text,
  -- raw commits the draft came from: [{ sha, message, author, date, url }]
  commits       jsonb NOT NULL DEFAULT '[]',
  created_by    uuid REFERENCES operators(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

CREATE TABLE announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('feature', 'maintenance', 'info', 'billing')),
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning')),
  starts_at     timestamptz,
  ends_at       timestamptz,
  cta_label     text,
  cta_url       text,
  -- { all: true } | { packs: [...] } | { agencyIds: [...] }
  target        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retracted')),
  created_by    uuid REFERENCES operators(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz NOT NULL DEFAULT now(),
  retracted_at  timestamptz
);

CREATE TABLE deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       uuid NOT NULL REFERENCES agencies(id),
  item_kind       text NOT NULL CHECK (item_kind IN ('release', 'announcement')),
  item_id         uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'unsupported', 'retracted')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  seen_users      int,
  total_users     int,
  seen_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, item_kind, item_id)
);
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX deliveries_item ON deliveries (item_kind, item_id);
