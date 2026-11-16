# Console agences

The tool our team uses to run the agency CRMs: create an agency from a 5-step form, then
upgrade, back up, restore, suspend, export and delete it, with health monitoring, alerts
and one central scheduler for every instance's cron jobs. It is Phase 2 (Console MVP) and
Phase 3 (operations) of `docs/AGENCY_PROVISIONING_PLAN.md` in the CRM repo.

Stack: Node 24 (runs the TypeScript directly, no build), Hono, postgres.js, Zod, AWS S3 SDK,
nodemailer. Postgres is the database and the job queue. Same layout as `lead-hub/`.

**Status (2026-10-26): running on our server** at `https://console.173-212-225-37.sslip.io`
(Dokploy project `agencies`, its own private Postgres `console-pg`, image from the server's local
registry `127.0.0.1:5000/console-agences:<sha>`). The demo agency, created by the CRM's
`npm run provision-agency`, was adopted (`npm run agency:adopt`) and then **upgraded by the
Console end to end**: pre-upgrade backup to MinIO, migrations from the new migrate image,
redeploy, health, in 4 min 15 s. Not exercised for real yet: creating an agency from the wizard,
restore, restore drill, suspend/resume, export, delete, per-agency MinIO keys.

Deployment notes from that run: `dl.min.io` no longer serves `mc` (the image installs Alpine's
`minio-client`); Dokploy domains are plain http behind the public proxy (TLS ends at Coolify's
Traefik). The Console's Postgres, app, mounts, domain and public route are created (and the app
redeployed) by `deploy/bootstrap-dokploy.mjs`; the agencies Postgres and MinIO it relies on by the CRM's
`scripts/provision-agency/server/bootstrap-infra.mjs`.

## Quick start (local)

```bash
npm install
cp .env.example .env          # set CONSOLE_ENCRYPTION_KEY (openssl rand -hex 32) and the PROVISION_* values
mkdir -p .data && npm run db:local   # terminal 1: embedded Postgres on :5434 (single session)
npm run operator:create -- vous@exemple.fr "Prénom Nom"   # prints a one-time setup link
npm run dev                   # terminal 2: http://localhost:3100
```

Open the setup link and choose a password: you are signed in.

Checks: `npm run typecheck`, `npm test` (44 tests: every operation end to end over a fake
fleet and a real in-process Postgres, the web flows, cron matching,
and a drift check between `src/provision/` and the CRM's `scripts/provision-agency/`).

## What it does

| Area | Behaviour |
|---|---|
| **Nouvelle agence** | Agency, brand (colours with live preview and contrast warning, font, 4 logos), address (immediate `<slug>.<platform>` or the agency's own domain with the CNAME line to copy), pack and options, recap. Submitting creates the row and the `provision` job. |
| **Live checklist** | Every step of the 13 provisioning steps, live (2 s poll). A failed step shows the error and what to do in plain French; **Relancer** resumes (done steps are skipped). |
| **Invitation** | The manager's invite link is emailed (SMTP) and also shown on the job page for 24 h, stored encrypted. Without SMTP the page says to pass the link on. |
| **Own domain** | The agency starts on the platform address; the Console re-checks the CNAME every 5 minutes and switches by itself (Dokploy domain, proxy route, `NEXTAUTH_URL`, brand `appUrl`). |
| **Fleet** | Name, address, state, health, version, seats used/included, storage, last backup. |
| **Upgrade** | Per agency, or for the fleet as a *rollout*: one agency at a time in the chosen order, stopping at the first failure (retrying that agency's job resumes it), progress on the fleet page. Pre-upgrade backup → migrations with the new migrate image → redeploy → health. If the new version does not come up, the previous image is redeployed automatically (migrations stay: additive rule). If that also fails, an alert is opened. |
| **Backups** | Nightly `pg_dump -Fc` of every agency to `BACKUP_BUCKET`, **encrypted** (AES-256-GCM, key derived from `CONSOLE_ENCRYPTION_KEY`; `npm run backup:decrypt` reads a copy without the Console), manual backups, 30-day retention (the newest is always kept), final backups kept 90 days. Exports are encrypted the same way. Download (decrypted) from the agency page. |
| **Off-site** | Every encrypted backup and export is copied to `OFFSITE_S3_*` (Backblaze B2, EU); a copy missing after 6 h opens an alert. |
| **Plateforme** | The Console's own database is dumped nightly (encrypted, off-site, same retention); alert after 36 h without one. |
| **Restore** | In place: safety backup of the current state, app stopped, `pg_restore --clean --single-transaction` (a failure leaves the base as it was), app restarted, health check. Typed confirmation. |
| **Restore drill** | Monthly: the latest backup is restored into a scratch database, checked (migrations, users), dropped. Failure opens an alert. |
| **Suspend / resume / offer** | Through the instance's `PUT /api/instance/license` (read-only mode, seats, features, AI quota). |
| **Export** | `POST /api/instance/export`, wait, copy of the zip into the platform bucket so it outlives the agency. |
| **Delete** | Two confirmation pages with the typed slug. Suspend → export → final backup → Dokploy app → proxy route → database and role → bucket and scoped key → record archived (secrets wiped). Each step is skipped on retry once done. "Forced" mode for a dead instance. |
| **Health and alerts** | Probe every minute; alert (in-app, email, Slack) after 3 failures in a row, "back online" note when it recovers. Also: cron job failing 3 times, no backup in 36 h, failed drill, failed automatic job, failed rollback. |
| **Central cron** | Reads each instance's `GET /api/instance/cron` catalog (refreshed every 6 h) and calls `POST /api/instance/cron` on schedule (UTC). Suspended agencies are skipped. Runs never overlap per job. |
| **Support** | Every agency's Support Technique tickets in one inbox (`/support`): views (non lus, sans réponse, urgents, en retard, bloqués, à valider), agencies, search and filters; the ticket's conversation read live from its CRM; reply, reply-and-move, status and priority sent through `/api/instance/support/*`, signed with the operator's name; canned replies; keyboard shortcuts (j/k, /, r, ⌘↵). Synced every 2 minutes (full pass daily), an alert while an agency has an urgent ticket open. Needs CRM images from 2026-11-06 on; older ones show "pas encore l’API support". |
| **Team and journal** | Operators by invitation link, email + password, 5 failures = 15 min lock. Four roles (`src/roles.ts`): Propriétaire (everything, the only one who deletes, manages the team, downloads the Console's dump), Opérateur, Support (reads, backs up, resolves alerts), Lecture. Password typed again before delete and restore. Open sessions listed and closable on the Team page. Journal with filters and CSV export. `npm run operator:role -- <email> owner` is the way back. |

## Deploy (Dokploy)

One application from this folder's `Dockerfile`, its own Postgres 17 (never an agency database).

- **Environment:** everything in `.env.example`. `CONSOLE_ENCRYPTION_KEY` encrypts every agency's
  secrets: keep a copy in the team vault; losing it means losing access to them.
- **Mounts:**
  - `/var/run/docker.sock` → same path: migrations and seed run the CRM's migrate image
    (`docker run --network $PROVISION_DOCKER_NETWORK`). This gives the Console root on the host,
    one more reason for team-only access and strong passwords.
  - the public proxy's dynamic directory (`/data/coolify/proxy/dynamic`) → same path
    (`PROVISION_PROXY_DYNAMIC_DIR`), for the per-agency route files.
  - the shared env file (SMTP, AI keys, OAuth apps, relay, socket) → `PROVISION_SHARED_ENV`.
- **Network:** the Console must reach the Postgres cluster (pg_dump, CREATE DATABASE), MinIO,
  Dokploy's API and every agency over HTTPS.
- **Registry login** for `docker run` of private images: `docker login ghcr.io` on the host.
- Domain: e.g. `console.<platform-domain>`, HTTPS (cookies are `Secure` when `CONSOLE_URL` is https).
- First operator: `npm run operator:create` in the container's terminal.

## Layout

```
src/
  index.ts            boot: config → migrate → HTTP + worker + scheduler
  config.ts           env (Zod); PROVISION_* names shared with the CRM's provision-agency
  platform.ts         settings shared by everything
  provision/          VENDORED from the CRM (plan.ts, run.ts, dokploy.ts, instance-auth.ts)
  infra/              Infra interface (types.ts) and the real servers (real.ts)
  jobs/               queue (SKIP LOCKED), handlers per kind, shared ops, worker
  scheduler.ts        health, central cron, nightly backups, retention, drills, DNS re-checks
  support.ts          support inbox: ticket sync, inbox queries, live ticket, replies, canned replies
  alerts.ts auth.ts agencies.ts packs.ts cron.ts crypto.ts
  http/               Hono app and server-rendered views (no client framework)
public/               app.css, common.js, job.js (live checklist), wizard.js
migrations/           plain SQL
test/                 fakes.ts (a whole fake fleet) + end-to-end tests
```

`src/provision/` is a copy of the CRM's `scripts/provision-agency/` (the Console runs in its own
repo and image). A fix to a step or a Dokploy call goes in both; `test/units.test.ts` fails when
`plan.ts` or the step list drifts while this folder sits inside the CRM checkout.

## Known limits

- Nothing has met real servers. Expect to adjust Dokploy calls (`application.stop/start/delete`
  were added from the API reference, response shapes guessed tolerantly) — see the CRM runbook §8.
- Backups are not encrypted by the Console: use a private bucket with server-side encryption.
- Packs (`src/packs.ts`) are placeholder figures to edit.
- Billing, usage metering and seat overage are Phase 4.
