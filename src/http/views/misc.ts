import { html } from 'hono/html';
import type { Agency } from '../../agencies.ts';
import type { Alert } from '../../alerts.ts';
import type { Operator, SessionRow } from '../../auth.ts';
import type { ConsoleBackupRow } from '../../jobs/ops.ts';
import type { Job } from '../../jobs/queue.ts';
import { can, ROLE_HINTS, ROLE_LABELS, ROLES } from '../../roles.ts';
import { JOB_KIND, JOB_STATUS, STEP_HINTS, STEP_ICON, ago, auditLabel, bytes, dateTime, pill } from './format.ts';
import { csrfField, jsonScript, page, type Chrome, type Html } from './layout.ts';

export type Invite = { inviteUrl: string; email: string; expiresAt?: string; emailed: boolean };

export function jobPage(input: { chrome: Chrome; job: Job; agency: Agency; invite: Invite | null; logs: { id: string; at: Date; line: string }[] }): Html {
  const { job, agency } = input;
  const st = JOB_STATUS[job.status];
  const body = html`
    <header class="page-head">
      <div><p class="crumbs"><a href="/">Agences</a> / <a href="/agencies/${agency.slug}">${agency.name}</a> /</p>
        <h1>${JOB_KIND[job.kind]} <span id="job-status">${pill(st.label, st.tone)}</span></h1>
        <p class="muted">Lancée ${dateTime(job.createdAt)}${job.attempts > 1 ? ` · tentative ${job.attempts}` : ''}</p></div>
      <div class="actions" id="job-actions">
        ${can(input.chrome.role, 'job.manage')
          ? html`<form method="post" action="/jobs/${job.id}/retry" class="inline" ${job.status === 'failed' || job.status === 'canceled' ? '' : 'hidden'} data-when="failed canceled">
              ${csrfField(input.chrome.csrf)}<button class="btn btn-primary" type="submit">Relancer</button></form>
            <form method="post" action="/jobs/${job.id}/cancel" class="inline" ${job.status === 'queued' ? '' : 'hidden'} data-when="queued">
              ${csrfField(input.chrome.csrf)}<button class="btn" type="submit">Annuler</button></form>`
          : ''}
      </div>
    </header>
    <div class="notice notice-danger" id="job-error" ${job.error ? '' : 'hidden'}>${jobErrorSummary(job)}</div>
    ${input.invite
      ? html`<section class="card invite">
          <h2>Invitation du manager</h2>
          <p>${input.invite.emailed ? html`Envoyée par email à <strong>${input.invite.email}</strong>. Le lien ci-dessous est le même, au cas où.` : html`<strong>L’email n’est pas parti</strong> (SMTP non configuré) : transmettez ce lien à ${input.invite.email}.`}</p>
          <div class="copy-row"><code id="invite-url" class="wrap">${input.invite.inviteUrl}</code><button class="btn btn-small" type="button" data-copy="#invite-url">Copier</button></div>
          <p class="small muted">Valable jusqu’au ${dateTime(input.invite.expiresAt)}. Ensuite : « Mot de passe oublié » sur la page de connexion de l’agence.</p>
        </section>`
      : ''}
    <section class="card">
      <ol class="checklist" id="checklist">
        ${job.steps.map(
          (s) => html`<li class="step step-${s.result}" data-id="${s.id}">
            <span class="step-icon" aria-hidden="true">${STEP_ICON[s.result]}</span>
            <div class="step-body"><span class="step-label">${s.label}</span>
              ${s.note ? html`<pre class="step-note">${s.note}</pre>` : ''}
              ${s.result === 'failed' && STEP_HINTS[s.id] ? html`<p class="step-hint">${STEP_HINTS[s.id]}</p>` : ''}</div></li>`,
        )}
      </ol>
    </section>
    <details class="card" id="log-box"><summary>Journal technique</summary><pre class="log" id="log">${input.logs.map((l) => `${new Date(l.at).toISOString().slice(11, 19)}  ${l.line}\n`).join('')}</pre></details>
    ${jsonScript('job-data', { id: job.id, status: job.status, lastLogId: input.logs.at(-1)?.id ?? 0, hints: STEP_HINTS, icons: STEP_ICON, statuses: JOB_STATUS })}`;
  return page(JOB_KIND[job.kind], body, { ...input.chrome, active: 'fleet' }, { scripts: ['job.js'] });
}

/**
 * The red banner of a failed job. When a step failed, its card already shows the raw error and what
 * to do: the banner says where it stopped instead of repeating the same text a third time.
 */
export function jobErrorSummary(job: Pick<Job, 'error' | 'steps'>): string {
  if (!job.error) return '';
  const failed = job.steps.find((s) => s.result === 'failed');
  return failed ? `Arrêt à l’étape « ${failed.label} ». La cause et quoi faire sont indiqués ci-dessous, puis « Relancer ».` : job.error;
}

export function alertsPage(input: { chrome: Chrome; open: (Alert & { agencyName: string | null; agencySlug: string | null })[]; recent: (Alert & { agencyName: string | null; agencySlug: string | null })[]; now: Date }): Html {
  const row = (a: (typeof input.open)[number], openRow: boolean) => html`<tr>
    <td>${a.agencySlug ? html`<a href="/agencies/${a.agencySlug}">${a.agencyName}</a>` : 'Plateforme'}</td>
    <td>${a.message}</td><td>${dateTime(a.openedAt)}</td>
    <td>${openRow && can(input.chrome.role, 'alert.resolve') ? html`<form method="post" action="/alerts/${a.id}/resolve" class="inline">${csrfField(input.chrome.csrf)}<button class="btn btn-small" type="submit">Marquer résolue</button></form>` : a.resolvedAt ? html`<span class="small muted">résolue ${ago(a.resolvedAt, input.now)}</span>` : ''}</td></tr>`;
  const body = html`
    <header class="page-head"><div><h1>Alertes</h1><p class="muted">Instance hors ligne (3 contrôles de suite), tâche planifiée en échec, sauvegarde manquante, test de restauration raté, mise à jour annulée.</p></div></header>
    <section class="card"><h2>Ouvertes</h2>
      ${input.open.length ? html`<div class="scroll-x"><table class="table"><tbody>${input.open.map((a) => row(a, true))}</tbody></table></div>` : html`<p class="muted">Rien à signaler.</p>`}</section>
    <section class="card"><h2>Historique</h2>
      ${input.recent.some((a) => a.resolvedAt)
        ? html`<div class="scroll-x"><table class="table compact"><tbody>${input.recent.filter((a) => a.resolvedAt).map((a) => row(a, false))}</tbody></table></div>`
        : html`<p class="muted">Aucune alerte résolue pour l’instant.</p>`}</section>`;
  return page('Alertes', body, { ...input.chrome, active: 'alerts' });
}

/** Short browser name from a user agent, for the sessions table. */
function browser(ua: string | null): string {
  if (!ua) return '—';
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua.slice(0, 40);
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${name} · ${os}` : name;
}

export function teamPage(input: {
  chrome: Chrome;
  operators: Operator[];
  me: string;
  sessions: SessionRow[];
  currentSession: string;
  setupLink?: { name: string; url: string };
  error?: string;
  flash?: string;
}): Html {
  const manage = can(input.chrome.role, 'team.manage');
  const csrf = input.chrome.csrf;
  const roleSelect = (name: string, selected: string) =>
    html`<select name="${name}">${ROLES.map((r) => html`<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)}</select>`;
  const body = html`
    <header class="page-head"><div><h1>Équipe</h1><p class="muted">Les personnes qui ont accès à la Console, leur rôle et leurs sessions ouvertes.${manage ? '' : ' Seul un Propriétaire peut inviter ou changer un rôle.'}</p></div></header>
    ${input.error ? html`<div class="notice notice-danger">${input.error}</div>` : ''}
    ${input.flash ? html`<div class="notice notice-ok">${input.flash}</div>` : ''}
    ${input.setupLink
      ? html`<div class="notice notice-ok">Lien d’accès pour ${input.setupLink.name} (valable 72 h, une seule fois) :
          <div class="copy-row"><code id="setup-url" class="wrap">${input.setupLink.url}</code><button class="btn btn-small" type="button" data-copy="#setup-url">Copier</button></div></div>`
      : ''}
    <section class="card"><div class="scroll-x"><table class="table">
      <thead><tr><th>Nom</th><th>Email</th><th>Rôle</th><th>Dernière connexion</th><th></th></tr></thead>
      <tbody>${input.operators.map(
        (o) => html`<tr class="${o.disabled ? 'muted' : ''}"><td>${o.name}${o.disabled ? html` <span class="small">(désactivé)</span>` : ''}</td><td>${o.email}</td>
          <td data-label="Rôle">${manage && o.id !== input.me
            ? html`<form method="post" action="/team/${o.id}/role" class="inline row-tight">${csrfField(csrf)}${roleSelect('role', o.role)}<button class="btn btn-small" type="submit">Changer</button></form>`
            : pill(ROLE_LABELS[o.role], o.role === 'owner' ? 'info' : 'muted')}</td>
          <td>${dateTime(o.lastLoginAt)}</td>
          <td class="actions">${o.id === input.me
            ? html`<span class="small muted">vous</span>`
            : manage
              ? html`<form method="post" action="/team/${o.id}/reset" class="inline" data-confirm="Réinitialiser l’accès de ${o.name} ? Un nouveau mot de passe sera à choisir.">${csrfField(csrf)}<button class="btn btn-small" type="submit">Nouveau lien</button></form>
                <form method="post" action="/team/${o.id}/${o.disabled ? 'enable' : 'disable'}" class="inline">${csrfField(csrf)}<button class="btn btn-small" type="submit">${o.disabled ? 'Réactiver' : 'Désactiver'}</button></form>`
              : ''}</td></tr>`,
      )}</tbody></table></div>
      <dl class="kv roles-legend">${ROLES.map((r) => html`<dt>${ROLE_LABELS[r]}</dt><dd class="small muted">${ROLE_HINTS[r]}</dd>`)}</dl>
    </section>
    <section class="card"><h2>Sessions ouvertes</h2>
      <p class="small muted">${manage ? 'Toutes les sessions de l’équipe.' : 'Vos sessions.'} Une session dure 12 h. Fermer une session déconnecte l’appareil concerné.</p>
      ${input.sessions.length
        ? html`<div class="scroll-x"><table class="table compact">
            <thead><tr>${manage ? html`<th>Personne</th>` : ''}<th>Ouverte</th><th>Expire</th><th>Appareil</th><th>Adresse IP</th><th></th></tr></thead>
            <tbody>${input.sessions.map(
              (x) => html`<tr>${manage ? html`<td>${x.operatorName}</td>` : ''}<td>${dateTime(x.createdAt)}</td><td>${dateTime(x.expiresAt)}</td>
                <td title="${x.userAgent ?? ''}">${browser(x.userAgent)}</td><td><code class="small">${x.ip ?? '—'}</code></td>
                <td class="actions">${x.tokenHash === input.currentSession
                  ? html`<span class="small muted">cette session</span>`
                  : html`<form method="post" action="/sessions/${x.tokenHash}/revoke" class="inline">${csrfField(csrf)}<button class="btn btn-small" type="submit">Fermer</button></form>`}</td></tr>`,
            )}</tbody></table></div>`
        : html`<p class="muted">Aucune.</p>`}
    </section>
    ${manage
      ? html`<section class="card narrow"><h2>Ajouter une personne</h2>
          <form method="post" action="/team" class="stack">${csrfField(csrf)}
            <label>Nom <input name="name" required maxlength="120" /></label>
            <label>Email <input name="email" type="email" required /></label>
            <label>Rôle ${roleSelect('role', 'operator')}</label>
            <button class="btn btn-primary" type="submit">Créer le lien d’accès</button></form></section>`
      : ''}`;
  return page('Équipe', body, { ...input.chrome, active: 'team' });
}

const DETAIL_LABELS: Record<string, string> = { reason: 'motif', tag: 'version', email: 'email', name: 'nom', pack: 'offre', slug: 'agence' };
const REASON_LABELS: Record<string, string> = { manual: 'manuelle', nightly: 'nuit', 'pre-upgrade': 'avant mise à jour' };

/** Journal detail: a link to the operation and short "label : value" pairs instead of raw JSON. */
function auditDetail(detail: unknown): Html | string {
  if (!detail || typeof detail !== 'object') return '';
  const d = detail as Record<string, unknown>;
  const pairs = Object.entries(d)
    .filter(([k, v]) => k !== 'jobId' && v != null && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${DETAIL_LABELS[k] ?? k} : ${k === 'reason' ? (REASON_LABELS[String(v)] ?? v) : v}`)
    .join(' · ');
  return html`${typeof d.jobId === 'string' ? html`<a href="/jobs/${d.jobId}">voir l’opération</a>${pairs ? ' · ' : ''}` : ''}${pairs}`;
}

export type AuditRow = { id: string; at: Date; action: string; detail: unknown; operatorName: string | null; agencyName: string | null; agencySlug: string | null; ip: string | null };
export type AuditFilters = { agency: string; operator: string; action: string; from: string; to: string };

/** Action families for the filter (prefix of the action code). */
export const AUDIT_FAMILIES: { value: string; label: string }[] = [
  { value: 'job.', label: 'Opérations sur les agences' },
  { value: 'agency.', label: 'Création d’agence' },
  { value: 'keys.', label: 'Clés des agences' },
  { value: 'rollout.', label: 'Mises à jour de la flotte' },
  { value: 'backup.', label: 'Téléchargements de sauvegardes' },
  { value: 'export.', label: 'Téléchargements d’exports' },
  { value: 'console.', label: 'Sauvegardes de la Console' },
  { value: 'operator.', label: 'Équipe' },
  { value: 'login', label: 'Connexions' },
  { value: 'session.', label: 'Sessions' },
  { value: 'reauth.', label: 'Confirmations refusées' },
  { value: 'alert.', label: 'Alertes' },
];

export function auditPage(input: {
  chrome: Chrome;
  rows: AuditRow[];
  filters: AuditFilters;
  agencies: { slug: string; name: string }[];
  operators: { id: string; name: string }[];
  /** Query string of the current filters (for the CSV link and "plus anciennes"). */
  query: string;
  nextBefore: string | null;
}): Html {
  const f = input.filters;
  const opt = (value: string, label: string, selected: string) => html`<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
  const filtered = Object.values(f).some(Boolean);
  const body = html`
    <header class="page-head"><div><h1>Journal</h1><p class="muted">Qui a fait quoi dans la Console. ${filtered ? 'Filtré.' : '200 actions par page.'}</p></div>
      <div class="actions"><a class="btn" href="/audit.csv${input.query ? `?${input.query}` : ''}">Exporter (CSV)</a></div></header>
    <form method="get" action="/audit" class="card filters">
      <label>Agence <select name="agency">${opt('', 'Toutes', f.agency)}${input.agencies.map((a) => opt(a.slug, a.name, f.agency))}</select></label>
      <label>Personne <select name="operator">${opt('', 'Toutes', f.operator)}${opt('system', 'Système (automatique)', f.operator)}${input.operators.map((o) => opt(o.id, o.name, f.operator))}</select></label>
      <label>Action <select name="action">${opt('', 'Toutes', f.action)}${AUDIT_FAMILIES.map((x) => opt(x.value, x.label, f.action))}</select></label>
      <label>Du <input type="date" name="from" value="${f.from}" /></label>
      <label>Au <input type="date" name="to" value="${f.to}" /></label>
      <div class="row"><button class="btn btn-primary" type="submit">Filtrer</button>${filtered ? html`<a class="btn" href="/audit">Tout afficher</a>` : ''}</div>
    </form>
    <section class="card"><div class="scroll-x"><table class="table compact">
      <thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Agence</th><th>Détail</th><th>IP</th></tr></thead>
      <tbody>${input.rows.length
        ? input.rows.map(
            (r) => html`<tr><td>${dateTime(r.at)}</td><td>${r.operatorName ?? 'système'}</td><td title="${r.action}">${auditLabel(r.action)}</td>
              <td>${r.agencySlug ? html`<a href="/agencies/${r.agencySlug}">${r.agencyName}</a>` : '—'}</td>
              <td class="small muted wrap-ok">${auditDetail(r.detail)}</td><td>${r.ip ? html`<code class="small">${r.ip}</code>` : ''}</td></tr>`,
          )
        : html`<tr><td colspan="6" class="muted">Aucune action pour ces filtres.</td></tr>`}</tbody></table></div>
      ${input.nextBefore ? html`<p><a class="btn btn-small" href="/audit?${input.query ? `${input.query}&` : ''}before=${input.nextBefore}">Plus anciennes</a></p>` : ''}
    </section>`;
  return page('Journal', body, { ...input.chrome, active: 'audit' });
}

/** The journal as CSV (Excel-friendly: semicolons, UTF-8 BOM). */
export function auditCsv(rows: AuditRow[]): string {
  const cell = (v: unknown) => {
    const t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [['date (UTC)', 'personne', 'action', 'code', 'agence', 'détail', 'ip'].join(';')];
  for (const r of rows) lines.push([new Date(r.at).toISOString(), r.operatorName ?? 'système', auditLabel(r.action), r.action, r.agencySlug ?? '', r.detail, r.ip ?? ''].map(cell).join(';'));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

// ---------- platform (the Console itself) ----------

export function platformPage(input: {
  chrome: Chrome;
  backups: ConsoleBackupRow[];
  offsite: { label: string; pending: number; failing: number } | null;
  backupHourUtc: number;
  retentionDays: number;
  running: boolean;
  flash?: string;
  now: Date;
}): Html {
  const csrf = input.chrome.csrf;
  const last = input.backups[0];
  const stale = !last || input.now.getTime() - new Date(last.createdAt).getTime() > 36 * 3_600_000;
  const offsiteCell = (b: ConsoleBackupRow) =>
    b.offsiteAt ? html`<span class="text-ok" title="${dateTime(b.offsiteAt)}">copiée</span>`
      : b.offsiteError ? html`<span class="text-danger small" title="${b.offsiteError}">échec, nouvel essai</span>`
      : input.offsite ? html`<span class="small muted">en attente</span>` : html`<span class="small muted">—</span>`;
  const body = html`
    <header class="page-head"><div><h1>Plateforme</h1><p class="muted">La Console elle-même : sa base, ses sauvegardes, la copie hors site et le chiffrement.</p></div></header>
    ${input.flash ? html`<div class="notice notice-ok">${input.flash}</div>` : ''}
    <div class="grid-3">
      <section class="card"><h2>Sauvegarde de la Console</h2>
        <dl class="kv">
          <dt>Dernière</dt><dd class="${stale ? 'text-danger' : ''}">${last ? `${ago(last.createdAt, input.now)} (${bytes(last.sizeBytes)})` : 'jamais'}</dd>
          <dt>Planning</dt><dd>chaque nuit à ${String(input.backupHourUtc).padStart(2, '0')}:00 UTC, gardée ${input.retentionDays} jours</dd>
        </dl>
        <p class="small muted">Sa base contient l’état scellé de chaque agence (mots de passe, secrets, identifiants Dokploy). Sans elle, plus aucune agence ne se pilote depuis la Console.</p>
        ${can(input.chrome.role, 'platform.backup')
          ? input.running
            ? html`<p class="small muted">Sauvegarde en cours…</p>`
            : html`<form method="post" action="/platform/backup" class="inline">${csrfField(csrf)}<button class="btn" type="submit">Sauvegarder maintenant</button></form>`
          : ''}
      </section>
      <section class="card"><h2>Copie hors site</h2>
        ${input.offsite
          ? html`<dl class="kv"><dt>Destination</dt><dd><code class="small">${input.offsite.label}</code></dd>
              <dt>En attente</dt><dd>${input.offsite.pending ? `${input.offsite.pending} copie(s)` : 'aucune'}${input.offsite.failing ? html` · <span class="text-danger">${input.offsite.failing} en échec</span>` : ''}</dd></dl>
              <p class="small muted">Chaque sauvegarde et export chiffré y est copié dans les minutes qui suivent ; une alerte s’ouvre si une copie manque après 6 h.</p>`
          : html`<p class="text-warn">Non configurée.</p>
              <p class="small muted">Les sauvegardes restent sur le même serveur que les agences. Renseignez <code>OFFSITE_S3_ENDPOINT</code>, <code>OFFSITE_S3_BUCKET</code>, <code>OFFSITE_S3_ACCESS_KEY_ID</code>, <code>OFFSITE_S3_SECRET_ACCESS_KEY</code> et <code>OFFSITE_S3_REGION</code> (Backblaze B2, région EU) puis redéployez la Console.</p>`}
      </section>
      <section class="card"><h2>Chiffrement</h2>
        <p class="small">Sauvegardes et exports sont chiffrés (AES-256-GCM) avant d’être écrits, avec une clé dérivée de <code>CONSOLE_ENCRYPTION_KEY</code>.</p>
        <p class="small muted">Gardez cette clé dans le coffre de l’équipe : sans elle, aucune sauvegarde ne se relit. Pour déchiffrer une copie sans la Console : <code>npm run backup:decrypt -- fichier.enc sortie</code>.</p>
      </section>
    </div>
    <section class="card"><h2>Sauvegardes de la base de la Console</h2>
      ${input.backups.length
        ? html`<div class="scroll-x"><table class="table compact">
            <thead><tr><th>Date</th><th>Type</th><th>Taille</th><th>Hors site</th><th></th></tr></thead>
            <tbody>${input.backups.map(
              (b) => html`<tr><td>${dateTime(b.createdAt)}</td><td>${b.reason === 'nightly' ? 'Nuit' : 'Manuelle'}</td><td>${bytes(b.sizeBytes)}</td><td>${offsiteCell(b)}</td>
                <td class="actions">${can(input.chrome.role, 'platform.download') ? html`<a class="btn btn-small" href="/platform/backups/${b.id}/download">Télécharger</a>` : ''}</td></tr>`,
            )}</tbody></table></div>`
        : html`<p class="muted">Aucune pour l’instant. La première a lieu cette nuit, ou maintenant avec le bouton.</p>`}
    </section>`;
  return page('Plateforme', body, { ...input.chrome, active: 'platform' });
}
