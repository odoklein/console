import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createAgency, getAgency, listAgencies, readState, updateAgency, type Agency, type LogoUpload, type StoredConfig } from '../agencies.ts';
import { openAlerts, recentAlerts } from '../alerts.ts';
import {
  audit,
  checkPassword,
  completeSetup,
  confirmPassword,
  createOperator,
  createSession,
  endSession,
  listOperators,
  listSessions,
  operatorBySetupToken,
  otherActiveOwners,
  passwordProblem,
  resetOperator,
  revokeSession,
  SESSION_TTL_MS,
  sessionFromToken,
  setOperatorDisabled,
  setOperatorRole,
  type Operator,
  type Session,
} from '../auth.ts';
import { tokenHash } from '../crypto.ts';
import { plannedSteps } from '../jobs/handlers.ts';
import { instanceApi, listBackups, listConsoleBackups, openStored } from '../jobs/ops.ts';
import { isIntegrationKey, keyMode, keyValueProblem, type InstanceKeyStatus } from '../integration-keys.ts';
import { cancel, enqueue, getJob, jobLogs, listJobs, requeue, type JobKind } from '../jobs/queue.ts';
import { log } from '../log.ts';
import { FEATURE_LABELS, packById, TIME_ZONES, type Features } from '../packs.ts';
import type { Platform } from '../platform.ts';
import { deriveNames, LOGO_SLOTS, validateAgencyConfig, type LogoSlot } from '../provision/plan.ts';
import { can, isRole, ROLE_LABELS, type Permission } from '../roles.ts';
import { getRollout, rolloutForFleet, startRollout, stopRollout } from '../rollouts.ts';
import { consoleBackupBusy, consoleBackupInBackground } from '../scheduler.ts';
import { agencyPage, confirmPage, type CronView, type ExportView } from './views/agency.ts';
import { keysPage, type FixedItem, type KeysView } from './views/keys.ts';
import { loginPage, messagePage, setupPage, notFoundPage } from './views/auth-pages.ts';
import { fleetPage, fleetUpgradePage } from './views/fleet.ts';
import { dateTime, JOB_KIND, JOB_STATUS } from './views/format.ts';
import type { Chrome } from './views/layout.ts';
import { alertsPage, auditCsv, auditPage, AUDIT_FAMILIES, jobPage, platformPage, teamPage, type AuditFilters, type AuditRow, type Invite } from './views/misc.ts';
import { wizardPage, type WizardValues } from './views/wizard.ts';

type Vars = { operator: Operator; session: Session; token: string; csrf: string };
type C = Context<{ Variables: Vars }>;

export type AppOptions = { p: Platform; secureCookies: boolean; onJobQueued?: () => void };

const COOKIE = 'console_session';
const PUBLIC_DIR = new URL('../../public/', import.meta.url);
const STATIC: Record<string, string> = { 'app.css': 'text/css', 'common.js': 'text/javascript', 'job.js': 'text/javascript', 'wizard.js': 'text/javascript' };
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MAX_LOGO_BYTES = 1_048_576;

const csrfFor = (token: string) => tokenHash(`csrf:${token}`);
const ipOf = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function sniffLogo(data: Uint8Array): string | null {
  const head = Buffer.from(data.subarray(0, 512));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (/<svg[\s>]/i.test(head.toString('utf8'))) return 'image/svg+xml';
  return null;
}

export function createApp(opts: AppOptions) {
  const { p } = opts;
  const { sql } = p;
  const app = new Hono<{ Variables: Vars }>();

  const kick = () => opts.onJobQueued?.();

  async function chrome(c: C, active?: Chrome['active']): Promise<Chrome> {
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM alerts WHERE resolved_at IS NULL`;
    const op = c.get('operator');
    return { operator: { name: op.name, email: op.email }, role: op.role, openAlerts: n?.n ?? 0, active, csrf: c.get('csrf') };
  }

  async function forbidden(c: C, perm: Permission) {
    log.warn('http.forbidden', { operator: c.get('operator').email, role: c.get('operator').role, perm, path: c.req.path });
    if (c.req.method === 'GET') return c.html(messagePage('Accès refusé', `Votre rôle (${ROLE_LABELS[c.get('operator').role]}) ne permet pas cette action. Demandez à un Propriétaire.`), 403);
    return c.text(`Accès refusé : votre rôle (${ROLE_LABELS[c.get('operator').role]}) ne permet pas cette action.`, 403);
  }

  /** Route guard: the signed-in operator's role must allow `perm`. */
  const need = (perm: Permission): MiddlewareHandler<{ Variables: Vars }> => async (c, next) => {
    if (!can(c.get('operator').role, perm)) return forbidden(c as C, perm);
    await next();
  };

  /** Streams a stored backup or export to the browser, decrypted; older unencrypted ones keep the signed link. */
  async function sendStored(c: C, row: { objectKey: string; encrypted: boolean }, filename: string) {
    if (!row.encrypted) return c.redirect(await p.infra.backups.url(row.objectKey, filename));
    const plain = await openStored(p, row);
    return c.body(Readable.toWeb(plain) as unknown as ReadableStream, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.\-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
  }

  /** The operator's password, typed again before delete and restore. Null when it is right. */
  async function passwordError(c: C, agencyId: string, password: string): Promise<string | null> {
    const r = await confirmPassword(sql, c.get('operator').id, password, ipOf(c));
    if (r === 'ok') return null;
    await audit(sql, { operatorId: c.get('operator').id, agencyId, action: 'reauth.failed', detail: { path: c.req.path }, ip: ipOf(c) });
    return r === 'throttled' ? 'Trop d’erreurs de mot de passe : réessayez dans 15 minutes.' : 'Mot de passe incorrect : rien n’a été lancé.';
  }

  function setSessionCookie(c: Context, token: string) {
    setCookie(c, COOKIE, token, { httpOnly: true, secure: opts.secureCookies, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_MS / 1000 });
  }

  async function queue(c: C, agencyId: string, kind: JobKind, params: Record<string, unknown> = {}) {
    const { id } = await enqueue(sql, { agencyId, kind, params, steps: plannedSteps(kind, params), createdBy: c.get('operator').id });
    await audit(sql, { operatorId: c.get('operator').id, agencyId, action: `job.${kind}`, detail: { jobId: id, ...redact(params) }, ip: ipOf(c) });
    kick();
    return id;
  }

  // ---------- every response ----------

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    // Google Fonts: the stylesheet comes from fonts.googleapis.com, the font files from fonts.gstatic.com.
    c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    if (opts.secureCookies) c.header('Strict-Transport-Security', 'max-age=31536000');
  });

  // Unknown pages (and c.notFound() for unknown agencies, jobs, backups) get a real page with a way back.
  app.notFound((c) => c.html(notFoundPage(), 404));

  app.get('/health', async (c) => {
    try {
      await sql`SELECT 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.get('/static/:file', async (c) => {
    const file = c.req.param('file');
    const type = STATIC[file];
    if (!type) return c.notFound();
    c.header('Cache-Control', 'no-cache');
    return c.body(await readFile(new URL(file, PUBLIC_DIR)), 200, { 'Content-Type': `${type}; charset=utf-8` });
  });

  // ---------- sign in ----------

  app.get('/login', async (c) => {
    const s = await sessionFromToken(sql, getCookie(c, COOKIE));
    if (s?.session.verified) return c.redirect('/');
    return c.html(loginPage({}));
  });

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const email = str(body.email);
    const r = await checkPassword(sql, email, String(body.password ?? ''), ipOf(c));
    if (!r.ok) {
      const msg = r.reason === 'throttled' ? 'Trop d’essais. Réessayez dans 15 minutes.' : 'Email ou mot de passe incorrect.';
      return c.html(loginPage({ error: msg, email }), r.reason === 'throttled' ? 429 : 401);
    }
    const token = await createSession(sql, r.operator.id, { ip: ipOf(c), userAgent: c.req.header('user-agent') ?? null });
    setSessionCookie(c, token);
    await audit(sql, { operatorId: r.operator.id, action: 'login', ip: ipOf(c) });
    return c.redirect('/');
  });

  // Old links and bookmarks from when a second step existed.
  app.get('/login/2fa', (c) => c.redirect('/'));

  app.get('/setup/:token', async (c) => {
    const op = await operatorBySetupToken(sql, c.req.param('token'));
    if (!op) return c.html(messagePage('Lien expiré', 'Ce lien n’est plus valable. Demandez-en un nouveau à un membre de l’équipe.'), 410);
    return c.html(setupPage({ name: op.name, token: c.req.param('token') }));
  });

  app.post('/setup/:token', async (c) => {
    const op = await operatorBySetupToken(sql, c.req.param('token'));
    if (!op) return c.html(messagePage('Lien expiré', 'Ce lien n’est plus valable. Demandez-en un nouveau à un membre de l’équipe.'), 410);
    const body = await c.req.parseBody();
    const pw = String(body.password ?? '');
    const problem = pw !== String(body.confirm ?? '') ? 'Les deux mots de passe diffèrent.' : passwordProblem(pw);
    if (problem) return c.html(setupPage({ name: op.name, token: c.req.param('token'), error: problem }), 400);
    await completeSetup(sql, op.id, pw);
    await audit(sql, { operatorId: op.id, action: 'operator.setup', ip: ipOf(c) });
    const token = await createSession(sql, op.id, { ip: ipOf(c), userAgent: c.req.header('user-agent') ?? null });
    setSessionCookie(c, token);
    return c.redirect('/');
  });

  // ---------- everything below needs a verified session ----------

  app.use('*', async (c, next) => {
    const token = getCookie(c, COOKIE);
    const s = await sessionFromToken(sql, token);
    if (!s) return c.req.method === 'GET' && !c.req.path.endsWith('/poll') ? c.redirect('/login') : c.json({ error: 'unauthenticated' }, 401);
    // A session left half-open by the former second step: sign in again.
    if (!s.session.verified) return c.req.method === 'GET' ? c.redirect('/login') : c.json({ error: 'unauthenticated' }, 401);
    c.set('operator', s.operator);
    c.set('session', s.session);
    c.set('token', token!);
    c.set('csrf', csrfFor(token!));
    if (c.req.method === 'POST') {
      const origin = c.req.header('origin');
      if (origin && new URL(origin).host !== new URL(c.req.url).host && new URL(origin).host !== c.req.header('host')) return c.text('Origine refusée', 403);
      const body = await c.req.parseBody();
      if (body._csrf !== c.get('csrf')) return c.text('Formulaire expiré, rechargez la page.', 403);
    }
    await next();
  });

  app.post('/logout', async (c) => {
    await endSession(sql, c.get('token'));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  // ---------- fleet ----------

  app.get('/', async (c) => {
    const agencies = await listAgencies(sql, { includeDeleted: c.req.query('all') === '1' });
    const running = await sql<{ agencyId: string; kind: JobKind }[]>`SELECT DISTINCT ON (agency_id) agency_id, kind FROM jobs WHERE status IN ('running', 'queued') ORDER BY agency_id, created_at`;
    const versions = [...new Set(agencies.filter((a) => (a.status === 'active' || a.status === 'suspended') && a.imageTag).map((a) => a.imageTag!))];
    const now = new Date();
    return c.html(fleetPage({ agencies, chrome: await chrome(c), now, runningJobs: new Map(running.map((r) => [r.agencyId, JOB_KIND[r.kind]])), versions, rollout: await rolloutForFleet(p, now) }));
  });

  app.get('/fleet/upgrade', need('agency.upgrade'), async (c) => c.html(fleetUpgradePage({ chrome: await chrome(c), agencies: await listAgencies(sql), defaultTag: p.settings.defaultTag })));

  // One agency at a time, in list order (the chosen first one first), stopping at the first failure.
  app.post('/fleet/upgrade', need('agency.upgrade'), async (c) => {
    const body = await c.req.parseBody({ all: true });
    const tag = str(body.tag);
    const first = str(body.first);
    const live = (await listAgencies(sql)).filter((a) => a.status === 'active' || a.status === 'suspended');
    const picked = new Set(([] as unknown[]).concat(body.agency ?? []).map(String));
    const ids = live.filter((a) => picked.has(a.id)).map((a) => a.id);
    if (first && ids.includes(first)) ids.unshift(...ids.splice(ids.indexOf(first), 1));
    const again = async (error: string) => c.html(fleetUpgradePage({ chrome: await chrome(c), agencies: live, defaultTag: tag, error }), 400);
    if (!TAG.test(tag) || !ids.length) return again('Indiquez une version et au moins une agence.');
    const started = await startRollout(p, { tag, agencyIds: ids, createdBy: c.get('operator').id });
    if ('error' in started) return again(started.error);
    await audit(sql, { operatorId: c.get('operator').id, action: 'rollout.start', detail: { tag, agencies: ids.length, rolloutId: started.rollout.id }, ip: ipOf(c) });
    kick();
    return c.redirect('/');
  });

  app.post('/rollouts/:id/stop', need('agency.upgrade'), async (c) => {
    const r = await getRollout(p, c.req.param('id'));
    if (!r) return c.notFound();
    if (await stopRollout(p, r.id)) await audit(sql, { operatorId: c.get('operator').id, action: 'rollout.stop', detail: { tag: r.tag, rolloutId: r.id }, ip: ipOf(c) });
    return c.redirect('/');
  });

  // ---------- wizard ----------

  app.get('/agencies/new', need('agency.create'), async (c) => c.html(wizardPage({ chrome: await chrome(c, 'new'), platformDomain: p.settings.platformDomain })));

  app.get('/api/slug', need('agency.create'), async (c) => {
    const slug = str(c.req.query('slug')).toLowerCase();
    const check = validateAgencyConfig({ slug, name: 'x', manager: { email: 'a@b.fr', name: 'x' } });
    if (!check.ok) return c.json({ available: false, reason: check.errors[0] });
    const taken = await getAgency(sql, slug);
    return c.json(taken ? { available: false, reason: 'déjà pris par une agence (même supprimée)' } : { available: true, host: deriveNames(slug, p.settings.platformDomain).platformHost });
  });

  app.post('/agencies', need('agency.create'), async (c) => {
    const body = await c.req.parseBody({ all: true });
    const values: WizardValues = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string' && k !== '_csrf') values[k] = v;
    const errors: string[] = [];

    const pack = packById(str(body.pack));
    if (!pack) errors.push('Choisissez un pack.');
    const tz = TIME_ZONES.find((t) => t.id === str(body.timeZone)) ?? TIME_ZONES[0]!;
    const color = (k: string, fallback: string) => {
      const v = str(body[k]);
      if (v && !/^#[0-9a-f]{6}$/i.test(v)) errors.push(`Couleur invalide : ${v}`);
      return v || fallback;
    };
    const intOrNull = (k: string, label: string) => {
      const v = str(body[k]);
      if (!v) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) errors.push(`${label} : nombre entier attendu.`);
      return n;
    };
    const features = Object.fromEntries((Object.keys(FEATURE_LABELS) as (keyof Features)[]).map((k) => [k, body[`feature_${k}`] === '1'])) as Features;
    const name = str(body.name);
    const legalName = str(body.legalName);
    const seatLimit = intOrNull('seatLimit', 'Utilisateurs inclus') ?? pack?.seats ?? null;
    const aiMonthlyQuota = intOrNull('aiMonthlyQuota', 'Quota IA');
    const own = str(body.addressMode) === 'own';
    if (own && !str(body.domain)) errors.push('Indiquez le domaine de l’agence, ou choisissez l’adresse immédiate.');
    const billingEmail = str(body.billingEmail);
    if (billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) errors.push('Email de facturation invalide.');

    const config: StoredConfig = {
      slug: str(body.slug).toLowerCase(),
      name,
      companyName: legalName || name,
      companyShortName: name,
      manager: { email: str(body.managerEmail), name: str(body.managerName) },
      domain: own ? str(body.domain).toLowerCase() : undefined,
      brand: {
        productName: name,
        senderName: name,
        lang: 'fr',
        locale: tz.locale,
        currency: tz.currency,
        timeZone: tz.id,
        primaryColor: color('primaryColor', '#1f3a5f'),
        accentColor: color('accentColor', '#e4572e'),
        fontPreset: ['default', 'inter', 'manrope'].includes(str(body.fontPreset)) ? str(body.fontPreset) : 'default',
      },
      license: { plan: pack?.id ?? null, seatLimit, features, aiMonthlyQuota },
      extra: { keys: 'agency', pack: pack?.id, legalName: legalName || undefined, billing: { name: str(body.billingName) || undefined, email: billingEmail || undefined } },
    };
    const check = validateAgencyConfig(config);
    if (!check.ok) errors.push(...check.errors.map(humanConfigError));
    else if (await getAgency(sql, config.slug)) errors.push(`Le nom court « ${config.slug} » est déjà pris.`);

    const logos: LogoUpload[] = [];
    for (const slot of LOGO_SLOTS) {
      const f = body[`logo_${slot}`];
      if (!(f instanceof File) || f.size === 0) continue;
      if (f.size > MAX_LOGO_BYTES) {
        errors.push(`Logo « ${slot} » : 1 Mo maximum.`);
        continue;
      }
      const data = new Uint8Array(await f.arrayBuffer());
      const type = sniffLogo(data);
      if (!type) errors.push(`Logo « ${slot} » : PNG, SVG ou WebP attendu.`);
      else logos.push({ slot: slot as LogoSlot, filename: f.name || `${slot}.${type.split('/')[1]!.replace('svg+xml', 'svg')}`, contentType: type, data });
    }

    if (errors.length) return c.html(wizardPage({ chrome: await chrome(c, 'new'), platformDomain: p.settings.platformDomain, values, errors }), 400);

    const names = deriveNames(config.slug, p.settings.platformDomain);
    const agency = await createAgency(sql, { config: check.ok ? { ...check.value, extra: config.extra } : config, primaryHost: names.platformHost, imageTag: p.settings.defaultTag, logos, createdBy: c.get('operator').id });
    await audit(sql, { operatorId: c.get('operator').id, agencyId: agency.id, action: 'agency.create', detail: { slug: config.slug, pack: pack?.id, domain: config.domain ?? null }, ip: ipOf(c) });
    const jobId = await queue(c, agency.id, 'provision', { tag: p.settings.defaultTag });
    return c.redirect(`/jobs/${jobId}`);
  });

  // ---------- one agency ----------

  app.get('/agencies/:slug', async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a) return c.notFound();
    const [jobs, backups, exports, crons, alerts] = await Promise.all([
      listJobs(sql, a.id, 15),
      listBackups(p, a.id),
      sql<ExportView[]>`SELECT id, size_bytes, created_at FROM exports WHERE agency_id = ${a.id} ORDER BY created_at DESC LIMIT 10`,
      sql<CronView[]>`SELECT job_id, schedule, description, last_run_at, last_ok, last_error, failures FROM agency_cron WHERE agency_id = ${a.id} ORDER BY job_id`,
      sql<{ id: string; message: string; openedAt: Date }[]>`SELECT id, message, opened_at FROM alerts WHERE agency_id = ${a.id} AND resolved_at IS NULL`,
    ]);
    return c.html(agencyPage({ chrome: await chrome(c, 'fleet'), agency: a, jobs, backups, exports, crons, alerts, platformDomain: p.settings.platformDomain, defaultTag: p.settings.defaultTag, now: new Date() }));
  });

  // ---------- keys & configuration ----------

  type KeysFetch = { keys: InstanceKeyStatus[] | null; error?: string };

  async function instanceKeys(a: Agency): Promise<KeysFetch> {
    const state = readState(p.sealer, a);
    if (!state) return { keys: null, error: 'Agence pas encore créée sur les serveurs.' };
    if (a.status !== 'active' && a.status !== 'suspended') return { keys: null, error: 'Agence pas en service.' };
    try {
      const res = await instanceApi(p, state)('GET', '/api/instance/integrations');
      if (res.status === 200 && Array.isArray(res.json?.keys)) return { keys: res.json.keys as InstanceKeyStatus[] };
      if (res.status === 404) return { keys: null, error: 'Cette version du CRM ne gère pas encore les clés modifiables : mettez l’agence à jour.' };
      return { keys: null, error: `L’instance a répondu HTTP ${res.status}.` };
    } catch {
      return { keys: null, error: 'L’instance ne répond pas.' };
    }
  }

  async function putKeys(a: Agency, values: Record<string, string | null>) {
    const state = readState(p.sealer, a)!;
    return instanceApi(p, state)('PUT', '/api/instance/integrations', JSON.stringify({ values }), { 'Content-Type': 'application/json' });
  }

  function fixedItems(a: Agency): FixedItem[] {
    const state = readState(p.sealer, a);
    const names = deriveNames(a.slug, p.settings.platformDomain);
    return [
      { name: 'NEXTAUTH_URL', label: 'Adresse', value: `https://${state?.primaryHost ?? a.primaryHost}`, note: 'Change seulement avec « Changer de domaine ».' },
      { name: 'INSTANCE_ID', label: 'Identifiant', value: a.slug },
      { name: 'DATABASE_URL', label: 'Base de données', value: names.dbName, note: `rôle ${names.dbRole} · ${p.settings.pg.host}:${p.settings.pg.port}` },
      { name: 'MINIO_BUCKET', label: 'Stockage', value: names.bucket, note: p.settings.minio.endpoint },
      { name: 'ENCRYPTION_KEY', label: 'Clé de chiffrement', value: '', sealed: true, note: 'Scelle les clés de l’agence et ses connexions email. Ne change jamais.' },
      { name: 'NEXTAUTH_SECRET', label: 'Secret des sessions', value: '', sealed: true },
      { name: 'INSTANCE_ADMIN_SECRET', label: 'Secret Console ↔ instance', value: '', sealed: true, note: 'Signe chaque appel de la Console.' },
      { name: 'CRON_SECRET', label: 'Secret des tâches planifiées', value: '', sealed: true },
      { name: 'DB · MinIO', label: 'Mots de passe techniques', value: '', sealed: true },
    ];
  }

  async function renderKeys(c: C, a: Agency, extra: Partial<KeysView> = {}, status: 200 | 400 | 502 = 200) {
    const fetched = await instanceKeys(a);
    const mode = keyMode(a);
    const shared = p.settings.shared;
    const view: KeysView = {
      chrome: await chrome(c, 'fleet'),
      agency: a,
      mode,
      fixed: fixedItems(a),
      platform: Object.keys(shared).sort().map((name) => ({ name, withheld: mode === 'agency' && isIntegrationKey(name) })),
      keys: fetched.keys,
      instanceError: fetched.error,
      adoptable: (fetched.keys ?? []).filter((k) => k.source === 'env' && shared[k.name]).map((k) => k.name),
      ...extra,
    };
    return c.html(keysPage(view), status);
  }

  app.get('/agencies/:slug/keys', async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a || a.status === 'deleted') return c.notFound();
    const saved = c.req.query('saved');
    const removed = c.req.query('removed');
    const adopted = c.req.query('adopted');
    const flash = saved ? { tone: 'ok' as const, text: `${saved} enregistrée : active d’ici quelques secondes.` }
      : removed ? { tone: 'ok' as const, text: `${removed} retirée.` }
      : adopted != null ? { tone: 'ok' as const, text: `Agence passée aux clés de l’agence (${adopted || 'aucune clé à copier'}). Le fichier commun ne lui transmettra plus ces clés à la prochaine mise à jour.` }
      : undefined;
    return renderKeys(c, a, { flash });
  });

  app.post('/agencies/:slug/keys', need('agency.keys'), async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a || a.status === 'deleted') return c.notFound();
    const body = await c.req.parseBody();
    const name = str(body.name);
    if (!isIntegrationKey(name)) return c.text('Clé inconnue.', 400);
    const remove = body.remove === '1';
    const value = typeof body.value === 'string' ? body.value.trim() : '';
    const problem = remove ? null : keyValueProblem(value);
    if (problem) return renderKeys(c, a, { flash: { tone: 'danger', text: `${name} : ${problem}` }, openKey: name }, 400);
    let res;
    try {
      res = await putKeys(a, { [name]: remove ? null : value });
    } catch {
      return renderKeys(c, a, { flash: { tone: 'danger', text: 'L’instance ne répond pas : rien n’a été modifié.' }, openKey: name }, 502);
    }
    if (res.status !== 200) {
      const why = res.json?.errors?.[name] ?? (res.status === 404 ? 'version du CRM trop ancienne' : `HTTP ${res.status}`);
      return renderKeys(c, a, { flash: { tone: 'danger', text: `${name} : ${why}` }, openKey: name }, 400);
    }
    await audit(sql, { operatorId: c.get('operator').id, agencyId: a.id, action: remove ? 'keys.remove' : 'keys.set', detail: { key: name }, ip: ipOf(c) });
    return c.redirect(`/agencies/${a.slug}/keys?${remove ? 'removed' : 'saved'}=${encodeURIComponent(name)}#k-${name}`);
  });

  app.post('/agencies/:slug/keys/adopt', need('agency.keys'), async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a || a.status === 'deleted') return c.notFound();
    if (keyMode(a) === 'agency') return c.redirect(`/agencies/${a.slug}/keys`);
    const fetched = await instanceKeys(a);
    if (!fetched.keys) return renderKeys(c, a, { flash: { tone: 'danger', text: `Impossible pour l’instant : ${fetched.error ?? 'instance injoignable'}` } }, 502);
    // Copy first, flip after: the agency never runs a minute without the keys it uses today.
    const values = Object.fromEntries(fetched.keys.filter((k) => k.source === 'env' && p.settings.shared[k.name]).map((k) => [k.name, p.settings.shared[k.name]!]));
    if (Object.keys(values).length) {
      let res;
      try {
        res = await putKeys(a, values);
      } catch {
        res = null;
      }
      if (!res || res.status !== 200) return renderKeys(c, a, { flash: { tone: 'danger', text: 'La copie des clés a échoué : l’agence reste sur les clés de la plateforme.' } }, 502);
    }
    const config: StoredConfig = { ...a.config, extra: { ...(a.config.extra ?? {}), keys: 'agency' } };
    await updateAgency(sql, a.id, { config: sql.json(config as never) });
    await audit(sql, { operatorId: c.get('operator').id, agencyId: a.id, action: 'keys.adopt', detail: { copied: Object.keys(values) }, ip: ipOf(c) });
    return c.redirect(`/agencies/${a.slug}/keys?adopted=${encodeURIComponent(Object.keys(values).join(', '))}`);
  });

  const UUID = /^[0-9a-f-]{36}$/i;

  app.get('/agencies/:slug/backups/:id/download', need('agency.download'), async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    const [b] = a && UUID.test(c.req.param('id')) ? await sql<{ objectKey: string; encrypted: boolean }[]>`SELECT object_key, encrypted FROM backups WHERE id = ${c.req.param('id')}::uuid AND agency_id = ${a.id} AND removed_at IS NULL` : [];
    if (!a || !b) return c.notFound();
    await audit(sql, { operatorId: c.get('operator').id, agencyId: a.id, action: 'backup.download', detail: { backupId: c.req.param('id') }, ip: ipOf(c) });
    return sendStored(c, b, b.objectKey.split('/').pop()!.replace(/\.enc$/, ''));
  });

  app.get('/agencies/:slug/exports/:id/download', need('agency.download'), async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    const [e] = a && UUID.test(c.req.param('id')) ? await sql<{ objectKey: string; encrypted: boolean }[]>`SELECT object_key, encrypted FROM exports WHERE id = ${c.req.param('id')}::uuid AND agency_id = ${a.id}` : [];
    if (!a || !e) return c.notFound();
    await audit(sql, { operatorId: c.get('operator').id, agencyId: a.id, action: 'export.download', detail: { exportId: c.req.param('id') }, ip: ipOf(c) });
    return sendStored(c, e, `${a.slug}-export.zip`);
  });

  async function restoreConfirm(c: C, a: Agency, backupId: string, error?: string) {
    const [b] = UUID.test(backupId) ? await sql<{ id: string; createdAt: Date; reason: string }[]>`SELECT id, created_at, reason FROM backups WHERE id = ${backupId}::uuid AND agency_id = ${a.id} AND removed_at IS NULL` : [];
    if (!b) return c.notFound();
    return c.html(
      confirmPage({
        chrome: await chrome(c, 'fleet'),
        agency: a,
        title: 'Restaurer une sauvegarde',
        lines: [
          `La base de ${a.name} va revenir à son état du ${dateTime(b.createdAt)}.`,
          'Tout ce qui a été saisi depuis sera perdu (une sauvegarde de l’état actuel est faite juste avant, pour revenir en arrière si besoin).',
          'L’application est arrêtée pendant la restauration (quelques minutes).',
        ],
        action: `/agencies/${a.slug}/actions/restore`,
        button: 'Restaurer',
        fields: html`<input type="hidden" name="backupId" value="${b.id}" />`,
        password: true,
        error,
      }),
      error ? 400 : 200,
    );
  }

  app.get('/agencies/:slug/restore/:backupId', need('agency.restore'), async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a) return c.notFound();
    return restoreConfirm(c, a, c.req.param('backupId'));
  });

  async function deleteReview(c: C, a: Agency, skip: boolean, error?: string) {
    return c.html(
      confirmPage({
        chrome: await chrome(c, 'fleet'),
        agency: a,
        title: `Supprimer ${a.name} (2/2)`,
        lines: [`Dernière confirmation. ${skip ? 'Suppression forcée : export et sauvegarde finale tentés, mais ignorés s’ils échouent.' : 'Export et sauvegarde finale d’abord ; s’ils échouent, rien n’est supprimé.'}`, 'Cette action ne peut pas être annulée.'],
        action: `/agencies/${a.slug}/actions/delete`,
        button: 'Supprimer définitivement',
        fields: html`<input type="hidden" name="skipExport" value="${skip ? '1' : ''}" /><input type="hidden" name="review" value="${tokenHash(`delete:${a.id}:${c.get('token')}`)}" />`,
        confirmed: true,
        password: true,
        error,
      }),
      error ? 400 : 200,
    );
  }

  app.get('/agencies/:slug/delete', need('agency.delete'), async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a || a.status === 'deleted') return c.notFound();
    return c.html(
      confirmPage({
        chrome: await chrome(c, 'fleet'),
        agency: a,
        title: `Supprimer ${a.name} (1/2)`,
        lines: [
          'L’accès est suspendu, puis toutes les données sont exportées (zip conservé par la Console).',
          'Une dernière sauvegarde de la base est faite (gardée 90 jours).',
          'Ensuite sont supprimés : l’application, la base de données, le stockage (fichiers, logos), la route publique.',
          'Le domaine de l’agence ne pointera plus vers rien : prévenez-la.',
        ],
        action: `/agencies/${a.slug}/delete/review`,
        button: 'Continuer',
        fields: html`<label class="check"><input type="checkbox" name="skipExport" value="1" /> L’instance ne répond plus : supprimer sans export ni sauvegarde finale si elles échouent</label>`,
      }),
    );
  });

  app.post('/agencies/:slug/delete/review', need('agency.delete'), async (c) => {
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a || a.status === 'deleted') return c.notFound();
    const body = await c.req.parseBody();
    if (str(body.confirm) !== a.slug) return c.redirect(`/agencies/${a.slug}/delete`);
    return deleteReview(c, a, body.skipExport === '1');
  });

  const ACTION_PERMISSION: Record<string, Permission> = {
    upgrade: 'agency.upgrade',
    backup: 'agency.backup',
    export: 'agency.export',
    suspend: 'agency.suspend',
    resume: 'agency.suspend',
    domain: 'agency.domain',
    license: 'agency.license',
    restore: 'agency.restore',
    delete: 'agency.delete',
  };

  app.post('/agencies/:slug/actions/:action', async (c) => {
    const perm = ACTION_PERMISSION[c.req.param('action')];
    if (!perm) return c.notFound();
    if (!can(c.get('operator').role, perm)) return forbidden(c, perm);
    const a = await getAgency(sql, c.req.param('slug'));
    if (!a || a.status === 'deleted') return c.notFound();
    const body = await c.req.parseBody();
    const live = a.status === 'active' || a.status === 'suspended';
    const back = (msg: string) => c.text(msg, 400);
    let jobId: string;
    switch (c.req.param('action')) {
      case 'upgrade': {
        const tag = str(body.tag);
        if (!live || !TAG.test(tag)) return back('Version invalide ou agence pas en service.');
        jobId = await queue(c, a.id, 'upgrade', { tag });
        break;
      }
      case 'backup':
        if (!live) return back('Agence pas en service.');
        jobId = await queue(c, a.id, 'backup', { reason: 'manual' });
        break;
      case 'export':
        if (!live) return back('Agence pas en service.');
        jobId = await queue(c, a.id, 'export');
        break;
      case 'suspend':
        if (a.status !== 'active') return back('Seule une agence active peut être suspendue.');
        jobId = await queue(c, a.id, 'suspend', { reason: str(body.reason).slice(0, 300) || undefined });
        break;
      case 'resume':
        if (a.status !== 'suspended') return back('L’agence n’est pas suspendue.');
        jobId = await queue(c, a.id, 'resume');
        break;
      case 'domain':
        if (!live) return back('Agence pas en service.');
        jobId = await queue(c, a.id, 'domain', { domain: str(body.domain).toLowerCase() || null });
        break;
      case 'license': {
        if (!live) return back('Agence pas en service.');
        const pack = packById(str(body.pack));
        const num = (k: string) => (str(body[k]) ? Number(str(body[k])) : null);
        const seatLimit = num('seatLimit') ?? pack?.seats ?? null;
        const aiMonthlyQuota = num('aiMonthlyQuota');
        if ((seatLimit != null && !(Number.isInteger(seatLimit) && seatLimit > 0)) || (aiMonthlyQuota != null && !(Number.isInteger(aiMonthlyQuota) && aiMonthlyQuota >= 0))) return back('Nombres invalides.');
        const features = Object.fromEntries((Object.keys(FEATURE_LABELS) as (keyof Features)[]).map((k) => [k, body[`feature_${k}`] === '1']));
        jobId = await queue(c, a.id, 'license', { pack: pack?.id, plan: pack?.id ?? a.config.license?.plan ?? null, seatLimit, aiMonthlyQuota, features });
        break;
      }
      case 'restore': {
        if (!live) return back('Agence pas en service.');
        if (str(body.confirm) !== a.slug) return back('Confirmation incorrecte : retapez le nom court.');
        const wrong = await passwordError(c, a.id, String(body.password ?? ''));
        if (wrong) return restoreConfirm(c, a, str(body.backupId), wrong);
        jobId = await queue(c, a.id, 'restore', { backupId: str(body.backupId) });
        break;
      }
      case 'delete': {
        if (str(body.confirm) !== a.slug || body.review !== tokenHash(`delete:${a.id}:${c.get('token')}`)) return back('Confirmation incorrecte.');
        const wrong = await passwordError(c, a.id, String(body.password ?? ''));
        if (wrong) return deleteReview(c, a, body.skipExport === '1', wrong);
        jobId = await queue(c, a.id, 'delete', { confirm: a.slug, skipExport: body.skipExport === '1' });
        break;
      }
      default:
        return c.notFound();
    }
    return c.redirect(`/jobs/${jobId}`);
  });

  // ---------- jobs ----------

  async function invite(job: { secretEnc: string | null; result: Record<string, unknown> | null }): Promise<Invite | null> {
    if (!job.secretEnc) return null;
    const s = JSON.parse(p.sealer.open(job.secretEnc)) as { inviteUrl?: string; email?: string; expiresAt?: string };
    if (!s.inviteUrl || (s.expiresAt && Date.parse(s.expiresAt) < Date.now())) return null;
    return { inviteUrl: s.inviteUrl, email: s.email ?? '', expiresAt: s.expiresAt, emailed: job.result?.inviteEmailed === true };
  }

  app.get('/jobs/:id', async (c) => {
    const job = await getJob(sql, c.req.param('id'));
    const agency = job && (await getAgency(sql, job.agencyId));
    if (!job || !agency) return c.notFound();
    return c.html(jobPage({ chrome: await chrome(c, 'fleet'), job, agency, invite: await invite(job), logs: await jobLogs(sql, job.id) }));
  });

  app.get('/jobs/:id/poll', async (c) => {
    const job = await getJob(sql, c.req.param('id'));
    if (!job) return c.json({ error: 'not_found' }, 404);
    const after = Number(c.req.query('after') ?? 0) || 0;
    return c.json({
      status: job.status,
      statusLabel: JOB_STATUS[job.status].label,
      statusTone: JOB_STATUS[job.status].tone,
      steps: job.steps,
      error: job.error,
      hasInvite: !!job.secretEnc,
      logs: (await jobLogs(sql, job.id, after)).map((l) => ({ id: Number(l.id), at: l.at, line: l.line })),
    });
  });

  app.post('/jobs/:id/retry', need('job.manage'), async (c) => {
    const job = await getJob(sql, c.req.param('id'));
    if (!job) return c.notFound();
    if (await requeue(sql, job.id)) {
      await audit(sql, { operatorId: c.get('operator').id, agencyId: job.agencyId, action: `job.retry`, detail: { jobId: job.id, kind: job.kind }, ip: ipOf(c) });
      kick();
    }
    return c.redirect(`/jobs/${job.id}`);
  });

  app.post('/jobs/:id/cancel', need('job.manage'), async (c) => {
    const job = await getJob(sql, c.req.param('id'));
    if (!job) return c.notFound();
    if (await cancel(sql, job.id)) {
      await audit(sql, { operatorId: c.get('operator').id, agencyId: job.agencyId, action: 'job.cancel', detail: { jobId: job.id, kind: job.kind }, ip: ipOf(c) });
      // Canceling the queued upgrade of a fleet rollout stops the rollout (nothing after it starts).
      if (typeof job.params.rolloutId === 'string') await stopRollout(p, job.params.rolloutId);
    }
    return c.redirect(`/jobs/${job.id}`);
  });

  // ---------- alerts, team, audit ----------

  app.get('/alerts', async (c) => c.html(alertsPage({ chrome: await chrome(c, 'alerts'), open: await openAlerts(sql), recent: await recentAlerts(sql), now: new Date() })));

  app.post('/alerts/:id/resolve', need('alert.resolve'), async (c) => {
    await sql`UPDATE alerts SET resolved_at = now() WHERE id = ${c.req.param('id')}::uuid AND resolved_at IS NULL`;
    await audit(sql, { operatorId: c.get('operator').id, action: 'alert.resolve', detail: { alertId: c.req.param('id') }, ip: ipOf(c) });
    return c.redirect('/alerts');
  });

  async function renderTeam(c: C, extra: { setupLink?: { name: string; url: string }; error?: string; flash?: string } = {}, status: 200 | 400 = 200) {
    const me = c.get('operator');
    return c.html(
      teamPage({
        chrome: await chrome(c, 'team'),
        operators: await listOperators(sql),
        me: me.id,
        sessions: await listSessions(sql, can(me.role, 'team.manage') ? null : me.id),
        currentSession: c.get('session').tokenHash,
        ...extra,
      }),
      status,
    );
  }

  app.get('/team', async (c) => renderTeam(c));

  app.post('/team', need('team.manage'), async (c) => {
    const body = await c.req.parseBody();
    const email = str(body.email).toLowerCase();
    const name = str(body.name);
    const role = isRole(body.role) ? body.role : 'operator';
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return renderTeam(c, { error: 'Nom et email valides requis.' }, 400);
    const [exists] = await sql`SELECT 1 FROM operators WHERE email = ${email}`;
    if (exists) return renderTeam(c, { error: 'Cette personne a déjà un accès.' }, 400);
    const { operator, setupToken } = await createOperator(sql, email, name, role);
    await audit(sql, { operatorId: c.get('operator').id, action: 'operator.create', detail: { email, operatorId: operator.id, role }, ip: ipOf(c) });
    return renderTeam(c, { setupLink: { name, url: `${p.settings.consoleUrl}/setup/${setupToken}` } });
  });

  app.post('/team/:id/:what', need('team.manage'), async (c) => {
    const id = c.req.param('id');
    const what = c.req.param('what');
    if (id === c.get('operator').id) return c.text('Impossible sur votre propre compte.', 400);
    const [op] = UUID.test(id) ? await sql<Operator[]>`SELECT * FROM operators WHERE id = ${id}::uuid` : [];
    if (!op) return c.notFound();
    const lastOwner = op.role === 'owner' && !op.disabled && (await otherActiveOwners(sql, op.id)) === 0;
    let setupLink: { name: string; url: string } | undefined;
    let flash: string | undefined;
    const detail: Record<string, unknown> = { operatorId: id, email: op.email };
    if (what === 'disable' || what === 'enable') {
      if (what === 'disable' && lastOwner) return renderTeam(c, { error: 'Impossible : c’est le dernier Propriétaire actif.' }, 400);
      await setOperatorDisabled(sql, id, what === 'disable');
    } else if (what === 'reset') {
      setupLink = { name: op.name, url: `${p.settings.consoleUrl}/setup/${await resetOperator(sql, id)}` };
    } else if (what === 'role') {
      const body = await c.req.parseBody();
      if (!isRole(body.role)) return c.text('Rôle inconnu.', 400);
      if (body.role !== 'owner' && lastOwner) return renderTeam(c, { error: 'Impossible : il faut au moins un Propriétaire actif.' }, 400);
      await setOperatorRole(sql, id, body.role);
      detail.role = body.role;
      detail.from = op.role;
      flash = `${op.name} : ${ROLE_LABELS[body.role]}.`;
    } else return c.notFound();
    await audit(sql, { operatorId: c.get('operator').id, action: `operator.${what}`, detail, ip: ipOf(c) });
    return renderTeam(c, { setupLink, flash });
  });

  app.post('/sessions/:hash/revoke', async (c) => {
    const me = c.get('operator');
    const hash = c.req.param('hash');
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.notFound();
    const owner = await revokeSession(sql, hash, can(me.role, 'team.manage') ? null : me.id);
    if (!owner) return c.notFound();
    await audit(sql, { operatorId: me.id, action: 'session.revoke', detail: { operatorId: owner }, ip: ipOf(c) });
    if (hash === c.get('session').tokenHash) {
      deleteCookie(c, COOKIE, { path: '/' });
      return c.redirect('/login');
    }
    return renderTeam(c, { flash: 'Session fermée.' });
  });

  // ---------- journal: filters, pages of 200, CSV ----------

  function auditFilters(c: C): { filters: AuditFilters; before: string | null } {
    const q = (k: string) => str(c.req.query(k));
    const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
    const operator = q('operator');
    return {
      filters: {
        agency: /^[a-z0-9-]{1,63}$/.test(q('agency')) ? q('agency') : '',
        operator: operator === 'system' || UUID.test(operator) ? operator : '',
        action: AUDIT_FAMILIES.some((f) => f.value === q('action')) ? q('action') : '',
        from: date(q('from')),
        to: date(q('to')),
      },
      before: /^\d{1,18}$/.test(q('before')) ? q('before') : null,
    };
  }

  async function auditRows(f: AuditFilters, before: string | null, limit: number): Promise<AuditRow[]> {
    const conds = [
      f.agency ? sql`a.slug = ${f.agency}` : null,
      f.operator === 'system' ? sql`l.operator_id IS NULL` : f.operator ? sql`l.operator_id = ${f.operator}::uuid` : null,
      f.action ? (f.action.endsWith('.') ? sql`l.action LIKE ${`${f.action}%`}` : sql`l.action = ${f.action}`) : null,
      f.from ? sql`(l.at AT TIME ZONE 'Europe/Paris')::date >= ${f.from}::date` : null,
      f.to ? sql`(l.at AT TIME ZONE 'Europe/Paris')::date <= ${f.to}::date` : null,
      before ? sql`l.id < ${before}::bigint` : null,
    ].filter((x) => x !== null);
    const where = conds.reduce((acc, x) => sql`${acc} AND ${x}`, sql`TRUE`);
    return sql<AuditRow[]>`
      SELECT l.id, l.at, l.action, l.detail, l.ip, o.name AS operator_name, a.name AS agency_name, a.slug AS agency_slug
      FROM audit_log l LEFT JOIN operators o ON o.id = l.operator_id LEFT JOIN agencies a ON a.id = l.agency_id
      WHERE ${where}
      ORDER BY l.id DESC LIMIT ${limit}`;
  }

  const auditQuery = (f: AuditFilters) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

  app.get('/audit', async (c) => {
    const { filters, before } = auditFilters(c);
    const rows = await auditRows(filters, before, 200);
    const [agencies, operators] = await Promise.all([
      sql<{ slug: string; name: string }[]>`SELECT slug, name FROM agencies ORDER BY name`,
      sql<{ id: string; name: string }[]>`SELECT id, name FROM operators ORDER BY name`,
    ]);
    return c.html(auditPage({ chrome: await chrome(c, 'audit'), rows, filters, agencies, operators, query: auditQuery(filters), nextBefore: rows.length === 200 ? String(rows.at(-1)!.id) : null }));
  });

  app.get('/audit.csv', async (c) => {
    const { filters } = auditFilters(c);
    const rows = await auditRows(filters, null, 20_000);
    return c.body(auditCsv(rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="journal-console-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    });
  });

  // ---------- platform: the Console's own backups, off-site copy, encryption ----------

  app.get('/platform', async (c) => {
    const [pending] = await sql<{ pending: number; failing: number }[]>`
      SELECT count(*)::int AS pending, count(*) FILTER (WHERE offsite_error IS NOT NULL)::int AS failing FROM (
        SELECT offsite_error FROM backups WHERE encrypted AND offsite_at IS NULL AND removed_at IS NULL
        UNION ALL SELECT offsite_error FROM exports WHERE encrypted AND offsite_at IS NULL
        UNION ALL SELECT offsite_error FROM console_backups WHERE encrypted AND offsite_at IS NULL AND removed_at IS NULL) x`;
    return c.html(
      platformPage({
        chrome: await chrome(c, 'platform'),
        backups: await listConsoleBackups(p),
        offsite: p.infra.offsite ? { label: p.infra.offsite.label, pending: pending?.pending ?? 0, failing: pending?.failing ?? 0 } : null,
        backupHourUtc: p.settings.backupHourUtc,
        retentionDays: p.settings.retentionDays,
        running: consoleBackupBusy(),
        flash: c.req.query('started') ? 'Sauvegarde de la Console lancée : rechargez la page dans quelques secondes.' : undefined,
        now: new Date(),
      }),
    );
  });

  app.post('/platform/backup', need('platform.backup'), async (c) => {
    void consoleBackupInBackground(p, 'manual');
    await audit(sql, { operatorId: c.get('operator').id, action: 'console.backup', ip: ipOf(c) });
    return c.redirect('/platform?started=1');
  });

  app.get('/platform/backups/:id/download', need('platform.download'), async (c) => {
    const [b] = UUID.test(c.req.param('id')) ? await sql<{ objectKey: string; encrypted: boolean }[]>`SELECT object_key, encrypted FROM console_backups WHERE id = ${c.req.param('id')}::uuid AND removed_at IS NULL` : [];
    if (!b) return c.notFound();
    await audit(sql, { operatorId: c.get('operator').id, action: 'console.download', detail: { backupId: c.req.param('id') }, ip: ipOf(c) });
    return sendStored(c, b, b.objectKey.split('/').pop()!.replace(/\.enc$/, ''));
  });

  app.onError((err, c) => {
    log.error('http.error', { path: c.req.path, error: err.message, stack: err.stack });
    return c.text('Erreur interne. Le détail est dans le journal de la Console.', 500);
  });

  return app;
}

function redact(params: Record<string, unknown>): Record<string, unknown> {
  const { confirm: _c, review: _r, ...rest } = params;
  return rest;
}

/** The vendored validator speaks in agency.json field names; the wizard speaks in labels. */
function humanConfigError(e: string): string {
  return e
    .replace(/^slug:/, 'Nom court :')
    .replace(/^name:/, 'Nom de l’agence :')
    .replace(/^manager\.email:/, 'Email du manager :')
    .replace(/^manager\.name:/, 'Nom du manager :')
    .replace(/^domain:/, 'Domaine :');
}
