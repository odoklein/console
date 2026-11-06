# Console agences — deep control plan

2026-10-29 · proposal, nothing built yet · lives in the Console repo (private), not in the
public CRM repo, because §1 lists security gaps.

Goal (Odo): push the Console from "provision and keep alive" to a **deep control console**:
see and steer everything inside and around each agency's CRM, from one place.

---

## 1. Where it stands

### What works (live since 2026-10-26, agencies: demo, pinglead)

| Area | Today |
|---|---|
| Create | 5-step wizard → 13 idempotent provisioning steps, live checklist, invite email |
| Keep alive | health probe every minute, alert after 3 failures (email/Slack), central cron |
| Change | upgrade (backup → migrate → deploy → health → auto-rollback), custom domain auto-switch, license (pack, seats, AI quota, 3 options), integration keys page |
| Data | nightly `pg_dump`, 30-day retention, monthly restore drill, in-place restore, export zip |
| End | suspend / resume, delete (export → final backup → every resource) |
| Team | operators by setup link, email + password, 5 failures = 15 min lock, journal |

### What the Console can see of an agency

One health snapshot (version, schema, `dbOk`, license status, seats used/limit), bucket size
(measured only at backup time), last backup, cron runs. Nothing about **who** uses the CRM,
**how much** (AI spend, calls, emails, contacts), **errors**, **logs**, or the **container**.
To answer "is PingLead OK and what does it cost us?" an operator still needs SSH and SQL.

### Gaps found

**A. The CRM does not enforce most of what the Console sets.**
- The AI quota is never read.
- Seats can be exceeded through client-portal accounts.
- A suspended agency's workers, webhooks and server actions keep running.
- Most modules (email hub, enrichment, public API, other AI routes) have no switch at all.

§3 has the line-by-line list. Part of the Console's license form currently changes nothing.

**B. Safety of the Console itself**

1. **No roles.** Every operator can delete or restore any agency and download every backup.
   The Console mounts `docker.sock`, i.e. root on the host.
2. **The Console's own database is backed up by nothing.** `console-pg` holds every agency's
   sealed state (DB/MinIO passwords, `INSTANCE_ADMIN_SECRET`, Dokploy ids). Lost = no agency
   can be operated from the Console until rebuilt by hand.
3. **Backups are on the same server as what they protect.** `BACKUP_S3_ENDPOINT` is not set in
   `deploy/bootstrap-dokploy.mjs`, so dumps land in the agencies' own MinIO on the same box.
   One disk failure (or a repeat of the October compromise) loses agencies **and** backups.
   Dumps are not encrypted by the Console either.
4. `CONSOLE_ENCRYPTION_KEY` exists only in `/root/provision/console.env` on the server.
5. No view of operator sessions, no way to revoke one.

**C. Operations blind spots**

1. Health keeps only the last probe: no uptime %, no latency, no incident history.
2. **Fleet upgrade is not "one by one"** as its page says: `WORKER_CONCURRENCY=2` and the queue
   only serialises per agency, so two agencies upgrade at once, and a failure does not stop the
   rest of the fleet.
3. A release is a free-text tag. No list of available images, no changelog, no channels.
4. The brand cannot be changed after creation, although the CRM has `PUT /api/instance/brand`
   and `/brand/assets`.
5. Database size is never measured; bucket size only at backup time.
6. No container view: CPU, RAM, restarts and logs need SSH.
7. Journal: last 200 rows, no filters, Console side only.
8. `src/packs.ts` (Essentiel / Équipe / Agence) does not match the commercial grid in the CRM's
   `OFFRES_ET_DIFFERENCIATION_MARCHE.md` (Indépendant 69 € / 1 seat, Small Business 229 € /
   3 seats, Medium Business 499 € / 8 seats, with quotas on contacts, workspaces, phone lines,
   Call Vault hours, AI "fiches RDV" and S3 storage, plus add-ons).

**D. Bug (verified live 2026-10-29).** The CSP (`style-src 'self'`, no `font-src`) blocks the
Google Fonts stylesheet: Space Grotesk and Inter never load on console.suzalink.com, every page
renders in system fonts.

---

## 2. Target: the agency page becomes a control room

```
Agences / PingLead
[Vue d'ensemble] [Utilisateurs] [Usage] [Offre & quotas] [Configuration] [Infrastructure] [Données] [Journal]
```

Eight control planes, each one a tab, plus a fleet cockpit above them.

### 2.0 Fleet cockpit (home page)
- Uptime 7 d / 30 d and probe latency per agency, open incidents.
- Version distribution, agencies behind the stable release.
- Quota warnings (≥ 80 %), seat overages, trials ending in ≤ 7 days.
- Activity: agencies with no login for 7 days (churn signal), today's active users per agency.
- **Host capacity**: RAM, disk, CPU of the shared server and "room for N more agencies" (the
  whole fleet shares one 8 vCPU / 24 GB / 300 GB box; demo idles at ~230 MB).
- Filters, sort, bulk actions (license change, announcement, upgrade).

### 2.1 Utilisateurs — the people inside an agency
- List: name, email, role, active, last login, created, seat counted or not.
- Actions: disable / enable, change role, send a password-reset link, resend invite, sign out
  everywhere (revoke sessions), transfer the main manager.
- **Accès support**: a 30-minute signed login into the agency's CRM, with a banner on every
  page ("Session support Suzalink — <operator>"), recorded in both journals. Login as any user; on by default, the agency's manager can switch it
  off (decision §6.1).

### 2.2 Usage — what they do and what it costs
- Daily series pulled from the instance: active users, logins, calls/actions, RDV booked,
  emails sent, contacts, workspaces (clients), AI requests / tokens / € cost by provider and
  feature (the CRM's `AiUsage` ledger), sourcing calls (Serper/Apify), storage, DB size.
- Server-rendered SVG sparklines (no client framework, CSP-safe), 30 / 90-day ranges, CSV.
- **Margin**: pack price vs measured cost (AI € + storage + RAM share) per agency, per month.

### 2.3 Offre & quotas — entitlements the CRM actually enforces
- **Modules** on/off: AI assistant, Captain Agent, Call Vault, email hub + sequences, sourcing,
  enrichment, Leexi / notetakers, public API + MCP, client portal ("Client spectateur"), white
  label, custom domain.
- **Limits**: staff seats, workspaces (clients), contacts, phone lines, Call Vault hours/month,
  AI envelope in €/month, storage GB, emails/day, sourcing credits/month, API requests/day.
- Each limit soft (warn at 80 %, banner in the CRM at 100 %) or hard (refused with a French
  message naming the pack).
- **Validity**: trial or paid-until date, grace days, then automatic suspension (with reminder
  emails to the agency manager at J-7 / J-1 and an alert to us).
- **Pack catalog** in the Console DB (not a TS file), aligned with the commercial grid, editable
  from the Console; an agency shows its pack plus its overrides and add-ons (extra seats,
  storage pack, AI top-up, white-label option, extra workspace).

### 2.4 Configuration
- **Brand editor** after creation: name, colours with contrast check, font, 4 logos (uses the
  existing brand + assets routes).
- **Réglages**: a whitelisted set of the agency's settings the instance itself declares
  (catalog pattern, like cron and integration keys): queue 24 h pause per list, SDR pace quota,
  notification defaults…
- **Clés** (exists) moves here.
- **Announcements**: a banner or modal inside the CRM, per agency or fleet-wide, with dates
  (maintenance notice, new feature, payment reminder).
- **Drift check**: the Console stores the desired license, brand, key mode and version; a
  nightly comparison with what the instance reports flags differences (hand edits in the DB,
  a failed job) with a "Réaligner" button.

### 2.5 Infrastructure
- Container: state, uptime, restarts, CPU / RAM now and 24 h, memory limit (per pack).
- **Logs**: last N lines, text filter, live tail, download; secrets scrubbed like job logs.
- Restart, stop / start, **maintenance mode** (the CRM shows a maintenance page with a message,
  the Console and `/api/instance/*` still work).
- Database: size, connections, ten largest tables.
- **Secret rotation** jobs: `NEXTAUTH_SECRET` (signs everyone out), `INSTANCE_ADMIN_SECRET`,
  `CRON_SECRET`, DB password, MinIO key. Never `ENCRYPTION_KEY` (stored keys would become
  unreadable).

### 2.6 Releases
- **Catalog**: tags read from the server's registry (`/v2/<repo>/tags/list`), with commit,
  date and message from the image labels; mark a tag `stable` or `beta`.
- **Channels**: each agency follows `stable`, `beta`, or is pinned to a tag.
- **Rollouts** replace the fleet form: ordered waves (a canary agency first), one agency at a
  time, stop at the first failure, optional window ("tonight 21:00 Paris"), pause / resume /
  abort, one page showing the whole rollout.
- **Rehearsal**: before upgrading an agency, restore its latest backup into a scratch DB and run
  the new migrate image on it (reuses the restore-drill code). "The migration passes on a copy
  of real data" becomes a checklist step, not a hope.
- **Builds**: a button runs the server-side image build from a commit (~25 min, capped builder,
  one at a time, live log); the tag lands in the catalog as `beta` (decision §6.8).

### 2.7 Données
- Backups, exports, restore (exist).
- **Off-site copy** of every dump to Backblaze B2 (EU), encrypted before upload.
- **Console self-backup**: nightly dump of `console-pg`, same off-site target.
- **Sandbox clone**: restore a backup into a temporary agency `<slug>-sandbox` (emails and cron
  off, deleted after 48 h) to debug or demo on real data without touching production.

### 2.8 Journal & operator control
- **Roles**: Propriétaire (everything, team, delete), Opérateur (create, upgrade, backup,
  license, keys, users), Support (read, users, support access; nothing destructive), Lecture.
  One `can(operator, action)` table checked at the route layer; the UI hides what you can't do.
- **Password re-entry** before delete, restore, secret rotation and support access. This is
  a confirmation, not 2FA: Odo's "email + password only" rule stands.
- Sessions page: mine and (owner) everyone's, revoke.
- Journal with filters (agency, operator, action, date), CSV export, and the instance's own
  security events merged in when the CRM exposes them.
- Command palette (Ctrl+K): jump to an agency, run an action.

---

## 3. CRM side: instance API v2

Everything stays HMAC-signed with the agency's `INSTANCE_ADMIN_SECRET`.

New first: **`GET /api/instance/capabilities`** → `{ api: 2, endpoints: [...] }`. The Console
reads it and greys out tabs an older image cannot serve (the keys page already degrades on 404;
this makes it systematic).

| Route | Purpose |
|---|---|
| `GET /api/instance/capabilities` | which v2 endpoints this image serves |
| `GET /api/instance/usage?from&to` | daily usage series (§2.2) |
| `GET /api/instance/users` · `PATCH /users/:id` · `POST /users/:id/reset-link` · `POST /users/:id/revoke-sessions` | people (§2.1) |
| `POST /api/instance/support-session` | one-time signed login, 30 min, banner (§2.1) |
| `PUT /api/instance/license` (extended) | modules, limits, validity, add-ons (§2.3) |
| `GET/PUT /api/instance/settings` | the instance declares its editable settings (§2.4) |
| `GET/PUT /api/instance/announcements` | in-app banners (§2.4) |
| `GET /api/instance/audit?after` | security / admin events for the merged journal (§2.8) |
| `GET /api/instance/health` (extended) | add DB size, uptime, last error time |

Enforcement: one server helper (`entitlements()` with `requireModule()` / `checkLimit()`) used by
every gated route, page and job; menus hide disabled modules. Today's state, module by module:

**What works.** Suspension makes every non-GET `/api/*` call return 403, from the middleware
(`middleware.ts:17`). The license state is read from the public `/api/license-state`, cached for
15 s, and the check fails open. The seat limit is checked in `checkSeatFor`
(`lib/license/server.ts:100`) when a user is created or reactivated. `aiAssistant` blocks
`/api/manager/assistant/*`, and `whiteLabel` blocks brand writes.

**Stored but never enforced**
- `aiMonthlyQuota` is validated and saved, and nothing reads it.
- `plan` is only a label.
- There is no expiry field at all.
- Gating is API-only: menus and pages never hide a module that is switched off.
- The Console's form has 3 options but the CRM knows 4. The `agent` option (Captain Agent) cannot
  be set from the Console.

**Bypasses (checked 2026-10-29)**
- **Seats.** Activating a client portal creates an active COMMERCIAL user, which counts as a
  seat, with no seat check (`lib/vault/portalAccounts.ts:124`). The same happens through the AI
  tool `lib/ai/tools/definitions/access.ts`.
- **`agent` gate.** It guards `/api/manager/agent`, a path that does not exist
  (`lib/license/gates.ts:13`). The real check is `agentAllowed` in the worker.
- **`callVault`.** Transcripts through `/api/v1` and MCP, and the recording proxy
  (`app/api/actions/[id]/recording`), check only the env, not the license.
- **Suspension** is not applied to:
  - server actions (e.g. `app/actions/mission-wizard.ts`), because only `/api/` paths are checked;
  - `/api/webhooks/allo`;
  - the agent, enrichment and messaging workers;
  - `/api/v1` and `/api/mcp`.

**No check at all**
- every other AI route (`app/api/ai/*`, `analyse-ia`, `generate-playbook`, `email/ai`,
  `enrichment/company-ai`, `analytics/ai-recap`);
- the email hub and its sequences;
- enrichment and Leexi;
- the public API and MCP;
- planning, billing, HR, comms and broadcasts.

Sourcing and notetakers only check that their key is present. `lib/config.ts` also has a dead
env-flag system that nothing calls.

**Observability.** The data exists in the CRM, but nothing reaches the Console:
- `AiUsage` (only the JSON, chat, pins and summary calls write to it; direct OpenAI, Mistral and
  Gemini calls are missing);
- `Action` and `IncomingCall`;
- `AuthEvent`, `UserSession` and `CrmActivityDay`;
- `File.size`;
- `Email` and `EmailAnalyticsDaily`;
- `ApiRequestDailyMetric`;
- `AuditEvent`.

Today the only way for the Console to get any of it is the full CSV export.

**Health.** `/api/instance/health` always answers 200 and does not compare the schema with the
migrations the image expects. There is no Docker HEALTHCHECK.

**Support login today.** The master password (SystemConfig `masterPasswordHash`,
`lib/auth.ts:111`) logs in as any user. It is set by an agency MANAGER, the Console can neither
see it nor set it, and nothing shows on screen during the session. The support access in §2.1
should replace it for our team.

**Order of the work.**
1. Write one `entitlements` module.
2. Apply it in the middleware, server actions, workers and v1/MCP, so they share one check.
3. Close the bypasses above.
4. Route every AI call through the `AiUsage` ledger, so the quota can count all of them.
5. Hide switched-off modules in the navigation.

---

## 4. Waves

Each wave ships on its own. CRM changes reach agencies only through a new server-built image and
a Console upgrade; every push to `feat/assistant-brain` also auto-deploys v02, so CRM-side work
for the Console should land in its own commits and be pushed deliberately.

| Wave | Console | CRM | Size |
|---|---|---|---|
| **0 · Harden** | CSP fix; encrypted Console self-backup + agency dumps copied to Backblaze B2; fleet upgrade one at a time + stop on failure; roles + password re-entry; sessions page; journal filters; `agent` option in the license form | seat check on portal accounts; `agent` gate on the real paths; suspension in server actions and workers | ~1–2 days |
| **1 · See inside** | tabbed agency page; Utilisateurs (read); Usage tab + sparklines; health history, uptime %, latency; host capacity; v02 in monitoring-only mode | `capabilities`, `usage`, `users` (read), health v2 | ~3 days |
| **2 · Steer inside** | Offre & quotas (pack catalog = commercial grid, overrides, add-ons, validity + auto-suspend); user actions; support access; brand editor; announcements | license v2 + enforcement in every gated module; every AI call through the `AiUsage` ledger; users write; support session + banner; announcements | ~5 days |
| **3 · Infra & releases** | container stats, logs, restart, maintenance mode; release catalog, channels, rollouts, rehearsal; image builds from the Releases page; secret rotation | maintenance page; settings catalog | ~4 days |
| **4 · Data & business** | sandbox clone; drift check; margin; manual billing ledger (Phase 4, no Stripe yet) | audit feed | ~4 days |

Sizes are working days of build + tests over the fake fleet; real-server checks on demo first,
pinglead only on Odo's go (as with the 71cabee upgrade).

---

## 5. What stays out

- No TOTP / authenticator (Odo, 2026-10-26).
- No Stripe until there is a budget; Wave 4 keeps a manual ledger.
- No point-in-time recovery (WAL archiving) for now: nightly dumps + off-site + drills.
- No multi-server orchestration: one host; the capacity view says when a second is needed.

---

## 6. Decisions (Odo, 2026-10-29)

| # | Question | Decision | Consequence for the build |
|---|---|---|---|
| 1 | Support access | **Log in as any user, on by default.** The agency's manager can switch it off in Paramètres. | 30-minute one-time login, banner on every page, logged in the Console journal and the CRM's `AuditEvent`. The master password stays for agencies' own use. |
| 2 | Operator roles | **Four roles; Odo is Propriétaire.** Propriétaire / Opérateur / Support / Lecture. | Only Propriétaire deletes agencies, manages the team and rotates secrets. Existing operators become Opérateur, except Odo. |
| 3 | AI quota unit | **€ cost per month**, read from the `AiUsage` ledger. | Agencies see "% de l'enveloppe IA utilisée", not euros. Every AI call must go through the ledger first: the direct OpenAI, Mistral and Gemini calls are not logged there today. |
| 4 | Over a limit, or expired | **Warn, then block, then suspend.** | A banner at 80 %. At 100 %, the action that would go over is refused (new user, import, AI call); what already exists keeps working. At the end date: 7 days' grace with emails at J-7 and J-1, then automatic suspension, plus an alert to us. |
| 5 | Packs | **The commercial grid.** Indépendant / Small Business / Medium Business / Sur mesure. | Seats, workspaces, contacts, phone lines, Call Vault hours, AI envelope and storage come from `OFFRES_ET_DIFFERENCIATION_MARCHE.md`, as are the add-ons. They live in a Console table and can be edited there. The AI envelope in € is derived from each pack's "fiches RDV" figure. demo and pinglead are mapped to a pack by hand. |
| 6 | Off-site backups | **Backblaze B2, EU region.** | Dumps are encrypted before upload; the key goes in the team vault, as with `CONSOLE_ENCRYPTION_KEY`. The first 10 GB are free and today's volume fits. This moves into Wave 0 and needs a B2 bucket and application key from Odo. |
| 7 | v02 (app.suzalink.com) | **Monitoring only.** | It shows up in the fleet with health, usage, logs and users. It has no license, upgrade, suspend, delete or backup buttons, and keeps auto-deploying from `feat/assistant-brain`. It needs `INSTANCE_ADMIN_SECRET` set on v02. Wave 1. |
| 8 | Builds | **Yes, from the Releases page.** | A build runs the existing capped builder on the server (~25 min), one build at a time, with a live log. The new tag lands in the catalog as `beta`. Wave 3. |

### Wave 0: built 2026-10-29 (uncommitted, not deployed)

Console: CSP fix, roles + password re-entry, sessions, journal filters/CSV, rollouts, encrypted
backups/exports, Console self-backup, off-site pass (needs `OFFSITE_S3_*`), Plateforme page,
`agent` option. 38 tests. CRM: COMMERCIAL takes no seat (Odo: the client's salespeople are not
agency staff, so no seat check on portal accounts), server actions and the agent/enrichment/messaging
workers stop while suspended. The `agent` gate needed nothing: Odo's 51c0f25 added the real
`/api/manager/agent/*` routes. Migration `0002_control.sql` runs on the next Console boot; the oldest
operator becomes Propriétaire.

### Wave 0 after these answers (as planned)

Console:
- fix the CSP;
- encrypted Console self-backup and agency dumps copied to B2;
- fleet upgrade one agency at a time, stopping at the first failure;
- the four roles, plus password re-entry before destructive actions;
- a sessions page;
- journal filters;
- the `agent` option in the license form.

CRM:
- a seat check on portal accounts;
- the `agent` gate on the real paths;
- suspension applied to server actions and workers.

Waiting on Odo: the B2 bucket and application key.
