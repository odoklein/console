-- « Nouveautés », second step: what the groundwork (0003_releases.sql) did not hold yet.
--   releases.summary / audience    the intro shown above the notes, and who sees them in the CRM
--   announcements.audience         same for announcements
--   deliveries.action              'put' (send or update) or 'delete' (retract) — the delivery pass
--                                  replays whichever is pending, with the same retry rules
--   deliveries.target              'tag' = sent because the agency runs the release's version,
--                                  'all' = sent to every agency regardless of version
ALTER TABLE releases ADD COLUMN summary text NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN audience text NOT NULL DEFAULT 'managers' CHECK (audience IN ('managers', 'everyone'));
ALTER TABLE releases ADD COLUMN target text NOT NULL DEFAULT 'tag' CHECK (target IN ('tag', 'all'));
ALTER TABLE releases ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE announcements ADD COLUMN audience text NOT NULL DEFAULT 'managers' CHECK (audience IN ('managers', 'everyone'));
ALTER TABLE deliveries ADD COLUMN action text NOT NULL DEFAULT 'put' CHECK (action IN ('put', 'delete'));
ALTER TABLE deliveries ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
