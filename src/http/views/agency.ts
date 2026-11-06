import { html } from 'hono/html';
import type { Agency } from '../../agencies.ts';
import type { BackupRow } from '../../jobs/ops.ts';
import type { Job } from '../../jobs/queue.ts';
import { FEATURE_LABELS, PACKS, packById, type Features } from '../../packs.ts';
import { can } from '../../roles.ts';
import { AGENCY_STATUS, JOB_KIND, JOB_STATUS, ago, bytes, dateTime, healthDot, healthReason, pill } from './format.ts';
import { csrfField, page, type Chrome, type Html } from './layout.ts';

export type CronView = { jobId: string; schedule: string; description: string | null; lastRunAt: Date | null; lastOk: boolean | null; lastError: string | null; failures: number };
export type ExportView = { id: string; sizeBytes: string; createdAt: Date };
export type AlertView = { id: string; message: string; openedAt: Date };

const REASON: Record<string, string> = { nightly: 'Nuit', manual: 'Manuelle', 'pre-upgrade': 'Avant mise à jour', 'pre-restore': 'Avant restauration', final: 'Finale' };

function action(slug: string, name: string, csrf: string | undefined, label: string, opts: { tone?: string; fields?: Html; confirm?: string } = {}): Html {
  return html`<form method="post" action="/agencies/${slug}/actions/${name}" class="inline" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}>
    ${csrfField(csrf)}${opts.fields ?? ''}<button class="btn ${opts.tone ? `btn-${opts.tone}` : ''}" type="submit">${label}</button>
  </form>`;
}

export function agencyPage(input: {
  chrome: Chrome;
  agency: Agency;
  jobs: Job[];
  backups: BackupRow[];
  exports: ExportView[];
  crons: CronView[];
  alerts: AlertView[];
  platformDomain: string;
  defaultTag: string;
  now: Date;
  /** Open Support Technique tickets, from the Console's support cache. */
  support?: { open: number; urgent: number; error: string | null } | null;
}): Html {
  const { agency: a, chrome, now } = input;
  const csrf = chrome.csrf;
  const may = (perm: Parameters<typeof can>[1]) => can(chrome.role, perm);
  const st = AGENCY_STATUS[a.status];
  const busy = input.jobs.find((j) => j.status === 'running' || j.status === 'queued');
  const live = a.status === 'active' || a.status === 'suspended';
  const lic = a.health?.license;
  const pack = packById(a.config.extra?.pack);
  const features = { ...(pack?.features ?? {}), ...(a.config.license?.features ?? {}) } as Partial<Features>;
  const provisionJob = input.jobs.find((j) => j.kind === 'provision');

  const head = html`<header class="page-head">
    <div>
      <p class="crumbs"><a href="/">Agences</a> /</p>
      <h1>${a.name} ${pill(st.label, st.tone)}</h1>
      <p class="muted">${a.status === 'deleted' ? `Supprimée ${dateTime(a.deletedAt)}` : html`<a href="https://${a.primaryHost}" target="_blank" rel="noopener">https://${a.primaryHost}</a>`}
        · créée ${dateTime(a.createdAt)}</p>
    </div>
    <div class="head-actions">
      ${a.status === 'active' || a.status === 'suspended'
        ? html`<a class="btn${input.support?.urgent ? ' btn-warn' : ''}" href="/support?agency=${a.slug}" title="${input.support?.error ? `Synchronisation : ${input.support.error}` : 'Tickets Support Technique de cette agence'}">Support${input.support ? html` <span class="badge badge-soft">${input.support.open}</span>` : ''}${input.support?.urgent ? html` <span class="small">${input.support.urgent} urgent${input.support.urgent > 1 ? 's' : ''}</span>` : ''}</a>
            <a class="btn" href="/agencies/${a.slug}/keys">Clés & configuration</a>`
        : ''}
      ${busy ? html`<a class="btn" href="/jobs/${busy.id}">${JOB_KIND[busy.kind]} : ${JOB_STATUS[busy.status].label.toLowerCase()}…</a>` : ''}
    </div>
  </header>`;

  const alerts = input.alerts.length
    ? html`<div class="notice notice-danger">${input.alerts.map((al) => html`<div>${al.message} <span class="small muted">(${ago(al.openedAt, now)})</span></div>`)}</div>`
    : '';

  if (a.status === 'failed' || a.status === 'provisioning') {
    return page(
      a.name,
      html`${head}${alerts}
        <section class="card">
          <h2>${a.status === 'failed' ? 'La création s’est arrêtée' : 'Création en cours'}</h2>
          <p>${a.status === 'failed' ? 'Corrigez la cause indiquée puis relancez : les étapes déjà faites ne sont pas refaites.' : 'Suivez les étapes en direct.'}</p>
          ${provisionJob ? html`<a class="btn btn-primary" href="/jobs/${provisionJob.id}">Voir les étapes</a>` : ''}
        </section>
        ${dangerZone(input, csrf)}`,
      { ...chrome, active: 'fleet' },
    );
  }

  const health = html`<section class="card">
    <h2>Santé ${healthDot(a.healthOk, '')}</h2>
    <dl class="kv">
      <dt>État</dt><dd>${a.healthOk == null ? 'pas encore contrôlée' : a.healthOk ? 'en ligne' : html`<span class="text-danger" title="${a.health?.error ?? ''}">hors ligne : ${healthReason(a.health?.error)}</span>`}
        <span class="small muted">(${ago(a.healthCheckedAt, now)})</span></dd>
      <dt>Version</dt><dd><code>${a.health?.version ?? a.imageTag ?? '—'}</code></dd>
      <dt>Schéma</dt><dd>${a.health?.schemaVersion ? html`<code class="small">${a.health.schemaVersion}</code>` : '—'}</dd>
      <dt>Licence</dt><dd>${lic?.status === 'SUSPENDED' ? pill('Suspendue', 'warn') : lic?.status ? pill('Active', 'ok') : '—'}</dd>
    </dl>
    ${live && may('agency.upgrade')
      ? html`<form method="post" action="/agencies/${a.slug}/actions/upgrade" class="row" data-confirm="Mettre à jour ${a.name} ? Une sauvegarde est faite avant, et la version précédente revient seule en cas d’échec.">
          ${csrfField(csrf)}<label class="grow">Mettre à jour vers <input name="tag" required value="${input.defaultTag}" pattern="[A-Za-z0-9_][A-Za-z0-9_.\\-]{0,127}" /></label>
          <button class="btn" type="submit">Mettre à jour</button></form>`
      : ''}
  </section>`;

  const address = html`<section class="card">
    <h2>Adresse web</h2>
    <ul class="plain">${a.domains.map((d) => html`<li><a href="https://${d}" target="_blank" rel="noopener">${d}</a> ${d === a.primaryHost ? pill('principale', 'info') : ''}</li>`)}</ul>
    ${a.domainPending && a.config.domain
      ? html`<div class="notice notice-warn">En attente du DNS pour <strong>${a.config.domain}</strong>. À ajouter chez le registrar de l’agence :
          <div class="copy-row"><code id="dns-${a.slug}">CNAME ${a.config.domain} → edge.${input.platformDomain}</code><button class="btn btn-small" type="button" data-copy="#dns-${a.slug}">Copier</button></div>
          <span class="small">Vérification automatique toutes les 5 minutes.</span></div>`
      : ''}
    ${live && may('agency.domain')
      ? html`<details><summary>Changer de domaine</summary>
          <form method="post" action="/agencies/${a.slug}/actions/domain" class="row">
            ${csrfField(csrf)}<label class="grow">Domaine de l’agence <input name="domain" value="${a.config.domain ?? ''}" placeholder="crm.agence.fr" /></label>
            <button class="btn" type="submit">Enregistrer</button></form>
          <p class="small muted">L’ancienne adresse continue de fonctionner.</p></details>`
      : ''}
  </section>`;

  const offer = html`<section class="card">
    <h2>Offre</h2>
    <dl class="kv">
      <dt>Pack</dt><dd>${pack?.label ?? a.config.license?.plan ?? '—'}</dd>
      <dt>Utilisateurs</dt><dd>${lic?.seatsUsed ?? '—'} / ${a.config.license?.seatLimit ?? lic?.seatLimit ?? '∞'}</dd>
      <dt>Options</dt><dd>${(Object.keys(FEATURE_LABELS) as (keyof Features)[]).filter((k) => features[k]).map((k) => FEATURE_LABELS[k]).join(', ') || '—'}</dd>
      <dt>Stockage</dt><dd>${bytes(a.storageBytes)}</dd>
      <dt>Facturation</dt><dd>${a.config.extra?.billing?.email ?? '—'}</dd>
    </dl>
    ${live && may('agency.license')
      ? html`<details><summary>Changer l’offre</summary>
          <form method="post" action="/agencies/${a.slug}/actions/license" class="stack">
            ${csrfField(csrf)}
            <label>Pack <select name="pack">${PACKS.map((p) => html`<option value="${p.id}" ${p.id === pack?.id ? 'selected' : ''}>${p.label}</option>`)}</select></label>
            <label>Utilisateurs inclus <input type="number" name="seatLimit" min="1" value="${a.config.license?.seatLimit ?? ''}" placeholder="illimité" /></label>
            <label>Quota IA mensuel <input type="number" name="aiMonthlyQuota" min="0" value="${a.config.license?.aiMonthlyQuota ?? ''}" placeholder="illimité" /></label>
            ${(Object.keys(FEATURE_LABELS) as (keyof Features)[]).map((k) => html`<label class="check"><input type="checkbox" name="feature_${k}" value="1" ${features[k] ? 'checked' : ''} /> ${FEATURE_LABELS[k]}</label>`)}
            <button class="btn" type="submit">Appliquer</button></form></details>`
      : ''}
  </section>`;

  const backups = html`<section class="card span-2">
    <div class="card-head"><h2>Sauvegardes</h2>${live && may('agency.backup') ? action(a.slug, 'backup', csrf, 'Sauvegarder maintenant') : ''}</div>
    ${input.backups.length
      ? html`<div class="scroll-x"><table class="table compact">
          <thead><tr><th>Date</th><th>Type</th><th>Taille</th><th>Version</th><th>Hors site</th><th>Test de restauration</th><th></th></tr></thead>
          <tbody>${input.backups.map(
            (b) => html`<tr>
              <td>${dateTime(b.createdAt)}</td><td>${REASON[b.reason] ?? b.reason}</td><td>${bytes(b.sizeBytes)}</td><td><code>${b.imageTag ?? '—'}</code></td>
              <td>${offsiteCell(b)}</td>
              <td class="wrap-ok">${b.verifiedAt ? html`<span class="text-ok">réussi</span> <span class="small muted">${b.verifyNote ?? ''}</span>` : b.verifyNote ? html`<span class="text-danger small">${b.verifyNote}</span>` : html`<span class="muted">—</span>`}</td>
              <td class="actions">
                ${may('agency.download') ? html`<a class="btn btn-small" href="/agencies/${a.slug}/backups/${b.id}/download">Télécharger</a>` : ''}
                ${live && may('agency.restore') ? html`<a class="btn btn-small" href="/agencies/${a.slug}/restore/${b.id}">Restaurer…</a>` : ''}
              </td></tr>`,
          )}</tbody></table></div>`
      : html`<p class="muted">Aucune sauvegarde. La première a lieu cette nuit, ou maintenant avec le bouton.</p>`}
    ${input.exports.length
      ? html`<h3>Exports des données</h3><ul class="plain">${input.exports.map(
          (e) => html`<li>${dateTime(e.createdAt)} · ${bytes(e.sizeBytes)}${may('agency.download') ? html` · <a href="/agencies/${a.slug}/exports/${e.id}/download">Télécharger (zip)</a>` : ''}</li>`,
        )}</ul>`
      : ''}
  </section>`;

  const crons = input.crons.length
    ? html`<section class="card span-2"><h2>Tâches planifiées</h2>
        <div class="scroll-x"><table class="table compact"><thead><tr><th>Tâche</th><th>Planning (UTC)</th><th>Dernier passage</th><th>État</th></tr></thead>
        <tbody>${input.crons.map(
          (c) => html`<tr><td class="wrap-ok">${c.jobId}<div class="small muted">${c.description ?? ''}</div></td><td><code>${c.schedule}</code></td><td>${ago(c.lastRunAt, now)}</td>
            <td>${c.lastOk == null ? '—' : c.lastOk ? html`<span class="text-ok">ok</span>` : html`<span class="text-danger" title="${c.lastError ?? ''}">échec${c.failures > 1 ? ` (${c.failures}×)` : ''}</span>`}</td></tr>`,
        )}</tbody></table></div></section>`
    : '';

  const jobs = html`<section class="card span-2"><h2>Opérations</h2>
    ${input.jobs.length
      ? html`<div class="scroll-x"><table class="table compact"><thead><tr><th>Opération</th><th>État</th><th>Lancée</th><th>Par</th></tr></thead>
        <tbody>${input.jobs.map(
          (j) => html`<tr><td><a href="/jobs/${j.id}">${JOB_KIND[j.kind]}</a>${j.kind === 'upgrade' ? html` <code class="small">${String(j.params.tag ?? '')}</code>` : ''}</td>
            <td>${pill(JOB_STATUS[j.status].label, JOB_STATUS[j.status].tone)}</td><td>${dateTime(j.createdAt)}</td><td class="small muted">${j.createdBy ? 'opérateur' : 'automatique'}</td></tr>`,
        )}</tbody></table></div>`
      : html`<p class="muted">Aucune.</p>`}</section>`;

  return page(
    a.name,
    html`${head}${alerts}<div class="grid-3">${health}${address}${offer}</div><div class="grid-2-wide">${backups}${crons}${jobs}</div>${dangerZone(input, csrf)}`,
    { ...chrome, active: 'fleet' },
  );
}

/** Where the off-site copy of a backup stands. */
function offsiteCell(b: BackupRow): Html {
  if (b.offsiteAt) return html`<span class="text-ok" title="${dateTime(b.offsiteAt)}">copiée</span>`;
  if (!b.encrypted) return html`<span class="small muted" title="Sauvegarde d’avant le chiffrement : jamais envoyée hors site">non chiffrée</span>`;
  if (b.offsiteError) return html`<span class="text-danger small" title="${b.offsiteError}">échec, nouvel essai</span>`;
  return html`<span class="small muted">en attente</span>`;
}

function dangerZone(input: { agency: Agency; chrome: Chrome }, csrf: string | undefined): Html {
  const a = input.agency;
  const may = (perm: Parameters<typeof can>[1]) => can(input.chrome.role, perm);
  if (a.status === 'deleted' || !(may('agency.export') || may('agency.suspend') || may('agency.delete'))) return '' as unknown as Html;
  return html`<section class="card danger-zone">
    <h2>Zone sensible</h2>
    ${may('agency.export')
      ? html`<div class="danger-row">
          <div><strong>Exporter toutes les données</strong><p class="small muted">Archive zip (un CSV par table), chiffrée et conservée par la Console.</p></div>
          ${a.status === 'active' || a.status === 'suspended' ? action(a.slug, 'export', csrf, 'Exporter') : ''}
        </div>`
      : ''}
    ${a.status === 'active' && may('agency.suspend')
      ? html`<div class="danger-row">
          <div><strong>Suspendre</strong><p class="small muted">L’agence passe en lecture seule (connexion possible pour exporter). Plus d’emails ni de tâches planifiées.</p></div>
          ${action(a.slug, 'suspend', csrf, 'Suspendre', { tone: 'warn', fields: html`<input name="reason" placeholder="Motif (visible par l’agence)" maxlength="300" />`, confirm: `Suspendre ${a.name} ?` })}
        </div>`
      : ''}
    ${a.status === 'suspended' && may('agency.suspend')
      ? html`<div class="danger-row"><div><strong>Réactiver</strong><p class="small muted">Retour à la normale immédiat.</p></div>${action(a.slug, 'resume', csrf, 'Réactiver')}</div>`
      : ''}
    ${may('agency.delete')
      ? html`<div class="danger-row">
          <div><strong>Supprimer l’agence</strong><p class="small muted">Export et sauvegarde finale, puis suppression de l’application, de la base et du stockage. Irréversible. Propriétaire seulement.</p></div>
          <a class="btn btn-danger" href="/agencies/${a.slug}/delete">Supprimer…</a>
        </div>`
      : ''}
  </section>`;
}

/** Second page of a dangerous action: what will happen, the typed name, the final button. */
export function confirmPage(input: {
  chrome: Chrome;
  agency: Agency;
  title: string;
  lines: string[];
  action: string;
  button: string;
  fields?: Html;
  error?: string;
  extra?: Html;
  /** Ask for the operator's password again (delete, restore). */
  password?: boolean;
  /** The typed slug is already checked (second page of a delete): don't ask again. */
  confirmed?: boolean;
}): Html {
  const a = input.agency;
  return page(
    input.title,
    html`<header class="page-head"><div><p class="crumbs"><a href="/">Agences</a> / <a href="/agencies/${a.slug}">${a.name}</a> /</p><h1>${input.title}</h1></div></header>
      ${input.error ? html`<div class="notice notice-danger">${input.error}</div>` : ''}
      <section class="card narrow danger-zone">
        <ul>${input.lines.map((l) => html`<li>${l}</li>`)}</ul>
        ${input.extra ?? ''}
        <form method="post" action="${input.action}" class="stack">
          ${csrfField(input.chrome.csrf)}${input.fields ?? ''}
          ${input.confirmed
            ? html`<input type="hidden" name="confirm" value="${a.slug}" />`
            : html`<label>Pour confirmer, tapez le nom court <code>${a.slug}</code><input name="confirm" required autocomplete="off" /></label>`}
          ${input.password ? html`<label>Votre mot de passe Console <input name="password" type="password" required autocomplete="current-password" /></label>` : ''}
          <div class="row"><a class="btn" href="/agencies/${a.slug}">Annuler</a><button class="btn btn-danger" type="submit">${input.button}</button></div>
        </form>
      </section>`,
    { ...input.chrome, active: 'fleet' },
  );
}
