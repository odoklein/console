import { html } from 'hono/html';
import type { Agency } from '../../agencies.ts';
import { PACKS } from '../../packs.ts';
import { can } from '../../roles.ts';
import {
  AUDIENCE_LABELS, CATEGORIES, CATEGORY_LABELS, NOTE_TYPE_LABELS, NOTE_TYPES,
  type Announcement, type Delivery, type Note, type Reach, type Release,
} from '../../news.ts';
import { icon } from './brand.ts';
import { ago, dateTime, pill } from './format.ts';
import { csrfField, jsonScript, page, type Chrome, type Html } from './layout.ts';

// ---------- small pieces ----------

const DELIVERY: Record<Delivery['status'], { label: string; tone: string }> = {
  pending: { label: 'En attente', tone: 'info' },
  delivered: { label: 'Envoyée', tone: 'ok' },
  failed: { label: 'Échec', tone: 'danger' },
  unsupported: { label: 'CRM trop ancien', tone: 'warn' },
  retracted: { label: 'Retirée', tone: 'muted' },
};

const CATEGORY_TONE: Record<string, string> = { feature: 'solar', maintenance: 'warn', info: 'info', billing: 'violet' };

function catChip(kind: string): Html {
  return html`<span class="nw-cat nw-cat-${CATEGORY_TONE[kind] ?? 'info'}">${CATEGORY_LABELS[kind as keyof typeof CATEGORY_LABELS] ?? kind}</span>`;
}

/** « 3/4 agences · 12 lu(s) sur 31 », with a thin bar for the reading rate. */
function reachCell(r: Reach | undefined): Html {
  if (!r || !r.agencies) return html`<span class="muted">—</span>`;
  const rate = r.audience ? Math.round((r.seen / r.audience) * 100) : null;
  return html`<div class="nw-reach">
    <span class="nw-reach-line"><span><strong>${r.delivered}</strong><span class="muted">/${r.agencies} agence${r.agencies > 1 ? 's' : ''}</span></span>
      ${r.failed ? html`<span class="text-danger small">· ${r.failed} en échec</span>` : ''}
      ${r.unsupported ? html`<span class="text-warn small">· ${r.unsupported} à mettre à jour</span>` : ''}
      ${r.pending ? html`<span class="muted small">· ${r.pending} en cours</span>` : ''}</span>
    ${rate != null
      ? html`<progress class="nw-meter" max="100" value="${rate}" title="${r.seen} personne(s) l’ont vue sur ${r.audience}">${rate} %</progress><span class="small muted">${rate} % lu · ${r.seen}/${r.audience}</span>`
      : r.delivered ? html`<span class="small muted">lecture : prochain relevé</span>` : ''}
  </div>`;
}

function targetLabel(a: Announcement, agencies: Agency[]): string {
  if ('all' in a.target) return 'Toutes les agences';
  if ('packs' in a.target) return `Offres : ${a.target.packs.map((id) => PACKS.find((p) => p.id === id)?.label ?? id).join(', ')}`;
  const names = a.target.agencyIds.map((id) => agencies.find((x) => x.id === id)?.name ?? '?');
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

const paris = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
function windowLabel(start: Date | null, end: Date | null): string {
  if (!start && !end) return '—';
  if (start && end) return `${paris.format(start)} → ${paris.format(end)}`;
  return start ? `dès ${paris.format(start)}` : `jusqu’au ${paris.format(end!)}`;
}

// ---------- index ----------

export function newsPage(input: {
  chrome: Chrome;
  releases: Release[];
  announcements: Announcement[];
  releaseReach: Map<string, Reach>;
  announcementReach: Map<string, Reach>;
  agencies: Agency[];
  defaultTag: string;
  flash?: string;
}): Html {
  const { chrome } = input;
  const live = input.agencies.filter((a) => a.status === 'active' || a.status === 'suspended');
  const versions = [...new Set(live.map((a) => a.imageTag).filter(Boolean))] as string[];
  const unsupported = [...input.releaseReach.values(), ...input.announcementReach.values()].reduce((n, r) => n + r.unsupported, 0);
  const published = input.releases.filter((r) => r.status === 'published');
  const activeAnn = input.announcements.filter((a) => a.status === 'published' && (!a.endsAt || a.endsAt > new Date()));
  const allReach = [...input.releaseReach.values(), ...input.announcementReach.values()];
  const seen = allReach.reduce((n, r) => n + r.seen, 0);
  const audience = allReach.reduce((n, r) => n + r.audience, 0);

  const body = html`
    <header class="page-head">
      <div>
        <h1>Nouveautés</h1>
        <p class="muted">Ce que les équipes des agences voient dans leur CRM : les notes de chaque version, et vos annonces.</p>
      </div>
      <div class="actions">
        ${can(chrome.role, 'release.manage') ? html`<a class="btn" href="/news/releases/new">${icon('tag', 16)} Notes de version</a>` : ''}
        ${can(chrome.role, 'announcement.send') ? html`<a class="btn btn-accent" href="/news/announcements/new">${icon('megaphone', 16)} Nouvelle annonce</a>` : ''}
      </div>
    </header>
    ${input.flash ? html`<div class="notice notice-ok">${input.flash}</div>` : ''}
    ${unsupported ? html`<div class="notice notice-warn">${unsupported} envoi(s) attendent une mise à jour : le CRM de ces agences ne connaît pas encore les Nouveautés. Ils partent tout seuls juste après leur prochaine mise à jour.</div>` : ''}
    <section class="stats" aria-label="Résumé">
      <div class="stat stat-accent"><span class="stat-label">Versions publiées</span><span class="stat-value">${published.length}</span><span class="stat-foot">${input.releases.length - published.length} brouillon(s)</span></div>
      <div class="stat"><span class="stat-label">Annonces en cours</span><span class="stat-value">${activeAnn.length}</span><span class="stat-foot">${input.announcements.length} au total</span></div>
      <div class="stat"><span class="stat-label">Lectures</span><span class="stat-value">${audience ? `${Math.round((seen / audience) * 100)} %` : '—'}</span><span class="stat-foot">${seen} vue(s) sur ${audience} destinataire(s)</span></div>
      <div class="stat"><span class="stat-label">Versions en service</span><span class="stat-value">${versions.length}</span><span class="stat-foot">${versions.map((v) => html`<code>${v}</code> `)}</span></div>
    </section>

    <div class="section-bar"><div><h2>Versions</h2><p class="small muted">Les notes d’une version arrivent dans le CRM d’une agence dès qu’elle tourne sur cette version.</p></div></div>
    ${input.releases.length
      ? html`<div class="table-wrap"><table class="table cards-sm">
          <thead><tr><th>Version</th><th>Titre</th><th>État</th><th>Notes</th><th>Diffusion</th><th>Publiée</th></tr></thead>
          <tbody>${input.releases.map((r) => html`<tr class="row-link">
            <td class="nowrap"><a class="nw-tag" href="/news/releases/${r.id}"><code>${r.tag}</code></a></td>
            <td><a class="strong nw-title-link" href="/news/releases/${r.id}">${r.title || 'Sans titre'}</a>${r.fromTag ? html`<div class="small muted">depuis ${r.fromTag}</div>` : ''}</td>
            <td data-label="État">${r.status === 'published' ? pill('Publiée', 'ok') : pill('Brouillon', 'muted')}</td>
            <td data-label="Notes">${noteCounts(r.notes)}</td>
            <td data-label="Diffusion">${r.status === 'published' ? reachCell(input.releaseReach.get(r.id)) : html`<span class="muted small">non publiée</span>`}</td>
            <td data-label="Publiée" class="nowrap small">${r.publishedAt ? dateTime(r.publishedAt) : html`<span class="muted">—</span>`}</td>
          </tr>`)}</tbody></table></div>`
      : html`<div class="nw-empty">${icon('tag', 22)}<div><strong>Aucune note de version.</strong><p class="muted small">Préparez celles de ${html`<code>${input.defaultTag}</code>`} : la Console propose un brouillon à partir des commits, vous le relisez, puis vous publiez.</p></div>
          ${can(chrome.role, 'release.manage') ? html`<a class="btn" href="/news/releases/new">Préparer</a>` : ''}</div>`}

    <div class="section-bar"><div><h2>Annonces</h2><p class="small muted">Maintenance, nouveauté, facturation : publiées tout de suite, pour toutes les agences ou seulement certaines.</p></div></div>
    ${input.announcements.length
      ? html`<div class="table-wrap"><table class="table cards-sm">
          <thead><tr><th>Type</th><th>Titre</th><th>Pour</th><th>Quand</th><th>Diffusion</th><th>Publiée</th></tr></thead>
          <tbody>${input.announcements.map((a) => html`<tr class="${a.status === 'retracted' ? 'is-faded' : ''}">
            <td class="nowrap">${catChip(a.kind)}${a.severity === 'warning' ? html` <span class="nw-warn-dot" title="Avertissement : bandeau dans le CRM">!</span>` : ''}</td>
            <td><a class="strong nw-title-link" href="/news/announcements/${a.id}">${a.title}</a>${a.status === 'retracted' ? html` ${pill('Retirée', 'muted')}` : ''}</td>
            <td data-label="Pour" class="small">${targetLabel(a, input.agencies)}<div class="muted">${AUDIENCE_LABELS[a.audience]}</div></td>
            <td data-label="Quand" class="small nowrap">${windowLabel(a.startsAt, a.endsAt)}</td>
            <td data-label="Diffusion">${a.status === 'retracted' ? html`<span class="muted small">retirée ${ago(a.retractedAt)}</span>` : reachCell(input.announcementReach.get(a.id))}</td>
            <td data-label="Publiée" class="nowrap small">${dateTime(a.publishedAt)}</td>
          </tr>`)}</tbody></table></div>`
      : html`<div class="nw-empty">${icon('megaphone', 22)}<div><strong>Aucune annonce.</strong><p class="muted small">Prévenez les agences d’une maintenance, d’une nouveauté ou d’un changement de facturation.</p></div>
          ${can(chrome.role, 'announcement.send') ? html`<a class="btn" href="/news/announcements/new">Écrire une annonce</a>` : ''}</div>`}`;
  return page('Nouveautés', body, { ...chrome, active: 'news' });
}

function noteCounts(notes: Note[]): Html {
  if (!notes.length) return html`<span class="muted small">—</span>`;
  return html`<span class="nw-counts">${NOTE_TYPES.map((t) => {
    const n = notes.filter((x) => x.type === t).length;
    const word = { new: ['nouveau', 'nouveaux'], improved: ['amélioré', 'améliorés'], fixed: ['corrigé', 'corrigés'] }[t];
    return n ? html`<span class="nw-note-chip nw-${t}">${n} ${word[n > 1 ? 1 : 0]}</span>` : '';
  })}</span>`;
}

// ---------- new release ----------

export function newReleasePage(input: { chrome: Chrome; tags: { tag: string; agencies: string[] }[]; defaultTag: string; fromTag: string | null; hasGithub: boolean; error?: string; values?: { tag: string; fromTag: string } }): Html {
  const v = input.values ?? { tag: input.defaultTag, fromTag: input.fromTag ?? '' };
  const body = html`
    <header class="page-head"><div><p class="crumbs"><a href="/news">Nouveautés</a> /</p><h1>Notes de version</h1>
      <p class="muted">Indiquez la version et celle d’avant : ${input.hasGithub ? 'la Console prépare un brouillon à partir des commits entre les deux.' : 'vous écrirez les notes à la main (GITHUB_TOKEN absent : pas de brouillon automatique).'}</p></div></header>
    ${input.error ? html`<div class="notice notice-danger">${input.error}</div>` : ''}
    <form method="post" action="/news/releases" class="card narrow stack">
      ${csrfField(input.chrome.csrf)}
      <div class="grid-2">
        <label>Version (tag de l’image) <input name="tag" required value="${v.tag}" list="nw-tags" autocomplete="off" spellcheck="false" /></label>
        <label>Depuis la version <input name="fromTag" value="${v.fromTag}" list="nw-tags" autocomplete="off" spellcheck="false" placeholder="ex. d80a9de" /></label>
      </div>
      <datalist id="nw-tags">${input.tags.map((t) => html`<option value="${t.tag}">${t.agencies.join(', ')}</option>`)}</datalist>
      ${input.tags.length ? html`<p class="small muted">En service : ${input.tags.map((t) => html`<code>${t.tag}</code> ${t.agencies.join(', ')} · `)}</p>` : ''}
      <div class="actions"><button class="btn btn-primary" type="submit">Préparer le brouillon</button><a class="btn btn-quiet" href="/news">Annuler</a></div>
    </form>`;
  return page('Notes de version', body, { ...input.chrome, active: 'news' });
}

// ---------- release editor ----------

function noteRow(n: Note | null, i: number): Html {
  const type = n?.type ?? 'new';
  return html`<li class="nw-note" data-note>
    <div class="nw-note-grip" aria-hidden="true">${icon('grip', 16)}</div>
    <div class="nw-note-fields">
      <div class="nw-note-top">
        <select name="n_type" aria-label="Type de la note ${i + 1}" class="nw-type nw-${type}">${NOTE_TYPES.map((t) => html`<option value="${t}" ${t === type ? 'selected' : ''}>${NOTE_TYPE_LABELS[t]}</option>`)}</select>
        <input name="n_title" aria-label="Titre de la note ${i + 1}" value="${n?.title ?? ''}" placeholder="Ce qui change, en une phrase" maxlength="140" class="nw-note-title" />
        <input name="n_module" aria-label="Module de la note ${i + 1}" value="${n?.module ?? ''}" placeholder="Module" maxlength="60" class="nw-note-module" />
      </div>
      <textarea name="n_body" aria-label="Détail de la note ${i + 1}" rows="2" maxlength="1000" placeholder="Détail (facultatif) : où le trouver, ce que ça change pour l’équipe">${n?.body ?? ''}</textarea>
    </div>
    <div class="nw-note-tools">
      <button type="button" class="nw-icon-btn" data-move="-1" aria-label="Monter la note" title="Monter">${icon('up', 16)}</button>
      <button type="button" class="nw-icon-btn" data-move="1" aria-label="Descendre la note" title="Descendre">${icon('down', 16)}</button>
      <button type="button" class="nw-icon-btn nw-danger" data-remove aria-label="Supprimer la note" title="Supprimer">${icon('trash', 16)}</button>
    </div>
  </li>`;
}

function deliveriesTable(rows: (Delivery & { agencyName: string; agencySlug: string; agencyTag: string | null })[], chrome: Chrome, kind: 'release' | 'announcement'): Html {
  if (!rows.length) return html`<div class="nw-empty">${icon('send', 22)}<div><strong>Aucun envoi pour l’instant.</strong><p class="muted small">${kind === 'release' ? 'Une fois publiée, la note part vers chaque agence qui tourne sur cette version (et vers les autres après leur mise à jour).' : 'Aucune agence ne correspond à la cible.'}</p></div></div>`;
  return html`<div class="table-wrap"><table class="table cards-sm">
    <thead><tr><th>Agence</th><th>Version</th><th>Envoi</th><th>Lue par</th><th>Détail</th><th></th></tr></thead>
    <tbody>${rows.map((d) => {
      const st = DELIVERY[d.status];
      const label = d.status === 'delivered' && d.action === 'put' ? 'Envoyée' : d.action === 'delete' && d.status !== 'retracted' ? 'Retrait en cours' : st.label;
      return html`<tr>
        <td class="nowrap"><a class="strong" href="/agencies/${d.agencySlug}">${d.agencyName}</a></td>
        <td data-label="Version"><code>${d.agencyTag ?? '—'}</code></td>
        <td data-label="Envoi">${pill(label, st.tone)}${d.deliveredAt && d.status === 'delivered' ? html`<div class="small muted">${ago(d.deliveredAt)}</div>` : ''}</td>
        <td data-label="Lue par">${d.totalUsers != null ? html`<span class="nw-seen"><strong>${d.seenUsers ?? 0}</strong><span class="muted">/${d.totalUsers}</span></span>` : html`<span class="muted small">${d.status === 'delivered' ? 'prochain relevé' : '—'}</span>`}</td>
        <td data-label="Détail" class="small">${d.lastError ? html`<span class="${d.status === 'failed' ? 'text-danger' : 'text-warn'}">${d.lastError}</span>${d.status === 'failed' ? html`<div class="muted">nouvel essai ${ago(d.nextAttemptAt).replace('il y a', 'dans').replace('dans dans', 'dans')}</div>` : ''}` : html`<span class="muted">${d.attempts ? `${d.attempts} envoi(s)` : ''}</span>`}</td>
        <td class="nw-act">${d.status === 'failed' && can(chrome.role, kind === 'release' ? 'release.manage' : 'announcement.send')
          ? html`<form method="post" action="/news/deliveries/${d.id}/retry" class="inline">${csrfField(chrome.csrf)}<button class="btn btn-small" type="submit">Réessayer</button></form>`
          : ''}</td>
      </tr>`;
    })}</tbody></table></div>`;
}

export function releasePage(input: {
  chrome: Chrome;
  release: Release;
  deliveries: (Delivery & { agencyName: string; agencySlug: string; agencyTag: string | null })[];
  onTag: string[];
  error?: string;
  flash?: string;
}): Html {
  const { release: r, chrome } = input;
  const editable = can(chrome.role, 'release.manage');
  const published = r.status === 'published';
  const body = html`
    <header class="page-head">
      <div>
        <p class="crumbs"><a href="/news">Nouveautés</a> / Versions /</p>
        <h1><code class="nw-h-tag">${r.tag}</code> ${r.title || 'Sans titre'} ${published ? pill('Publiée', 'ok') : pill('Brouillon', 'muted')}</h1>
        <p class="muted small">${r.fromTag ? html`Commits depuis <code>${r.fromTag}</code> · ` : ''}${published ? `publiée le ${dateTime(r.publishedAt)}` : 'pas encore visible dans les CRM'} · ${input.onTag.length ? `en service chez ${input.onTag.join(', ')}` : 'aucune agence sur cette version pour l’instant'}</p>
      </div>
      ${editable ? html`<div class="actions">
        ${published ? html`<form method="post" action="/news/releases/${r.id}/retract" class="inline" data-confirm="Retirer ces notes des CRM ? Elles disparaissent du panneau Nouveautés de chaque agence. Vous pourrez les republier.">${csrfField(chrome.csrf)}<button class="btn btn-quiet" type="submit">Retirer</button></form>` : ''}
        <button class="btn" type="submit" form="nw-editor" name="intent" value="save">Enregistrer</button>
        <button class="btn btn-accent" type="submit" form="nw-editor" name="intent" value="publish">${published ? 'Republier les modifications' : 'Publier'}</button>
      </div>` : ''}
    </header>
    ${input.flash ? html`<div class="notice notice-ok">${input.flash}</div>` : ''}
    ${input.error ? html`<div class="notice notice-danger">${input.error}</div>` : ''}
    <div class="nw-split">
      <form method="post" action="/news/releases/${r.id}" id="nw-editor" class="nw-editor" ${editable ? '' : 'inert'}>
        ${csrfField(chrome.csrf)}
        <div class="nw-block">
          <label>Titre <input name="title" value="${r.title}" maxlength="140" required placeholder="ex. Tutoriels vidéo et connexion Onoff" data-pv="title" /></label>
          <label><span class="nw-label">Résumé <span class="muted small">(facultatif, affiché au-dessus des notes)</span></span><textarea name="summary" rows="2" maxlength="4000" data-pv="summary" placeholder="Deux nouveautés pour vos équipes, et quelques corrections.">${r.summary}</textarea></label>
          <div class="nw-choices">
            <fieldset class="nw-seg"><legend>Visible par</legend><div class="nw-seg-track">
              ${(['managers', 'everyone'] as const).map((a) => html`<label class="nw-seg-opt"><input type="radio" name="audience" value="${a}" ${r.audience === a ? 'checked' : ''} /><span>${a === 'managers' ? 'Managers' : 'Toute l’équipe'}</span></label>`)}
            </div></fieldset>
            <fieldset class="nw-seg"><legend>Envoyer à</legend><div class="nw-seg-track">
              <label class="nw-seg-opt"><input type="radio" name="target" value="tag" ${r.target === 'tag' ? 'checked' : ''} /><span>Agences sur ${r.tag}</span></label>
              <label class="nw-seg-opt"><input type="radio" name="target" value="all" ${r.target === 'all' ? 'checked' : ''} /><span>Toutes les agences</span></label>
            </div></fieldset>
          </div>
        </div>
        <div class="nw-block">
          <div class="nw-block-head"><h2>Notes <span class="muted small" data-count>${r.notes.length}</span></h2>
            <span class="small muted">Écrites pour l’équipe de l’agence : ce qui change pour elle, pas le détail technique.</span></div>
          <ol class="nw-notes" data-notes>${r.notes.length ? r.notes.map((n, i) => noteRow(n, i)) : noteRow(null, 0)}</ol>
          <template id="nw-note-template">${noteRow(null, 0)}</template>
          <button type="button" class="btn btn-small nw-add" data-add>${icon('plus', 15)} Ajouter une note</button>
        </div>
        ${r.commits.length ? html`<details class="nw-block nw-commits"><summary>${r.commits.length} commit(s) d’origine</summary>
          <ul class="nw-commit-list">${r.commits.map((c) => html`<li><a href="${c.url}" target="_blank" rel="noopener"><code>${c.sha.slice(0, 7)}</code></a> <span>${c.message.split('\n')[0]}</span> <span class="muted small">${c.author}</span></li>`)}</ul>
        </details>` : ''}
      </form>
      <aside class="nw-preview-col" aria-label="Aperçu dans le CRM">
        <div class="nw-preview-sticky">
          <p class="nw-preview-label">${icon('eye', 15)} Aperçu dans le CRM</p>
          <div class="nw-crm">
            <div class="nw-crm-head"><strong>Nouveautés</strong><span>Ce qui change dans votre CRM, et ce qui arrive bientôt.</span></div>
            <article class="nw-crm-card nw-crm-release" data-preview="release">
              <div class="nw-crm-meta"><span class="nw-crm-kind">${icon('rocket', 13)} Mise à jour</span><code>${r.tag}</code><span class="nw-crm-unread">Non lu</span><span class="nw-crm-date">aujourd’hui</span></div>
              <h3 data-pv-out="title">${r.title || 'Sans titre'}</h3>
              <p data-pv-out="summary" ${r.summary ? '' : 'hidden'}>${r.summary}</p>
              <div data-pv-out="notes"></div>
            </article>
          </div>
        </div>
      </aside>
    </div>
    <div class="section-bar"><div><h2>Envois</h2><p class="small muted">Une ligne par agence. « Lue par » : personnes de l’agence qui ont ouvert le panneau, sur celles qui peuvent le voir.</p></div></div>
    ${deliveriesTable(input.deliveries, chrome, 'release')}
    ${jsonScript('nw-labels', NOTE_TYPE_LABELS)}`;
  return page(`Version ${r.tag}`, body, { ...chrome, active: 'news' }, { scripts: ['news.js'] });
}

// ---------- announcements ----------

export type AnnouncementForm = {
  kind: string; title: string; body: string; severity: string; audience: string;
  startsAt: string; endsAt: string; ctaLabel: string; ctaUrl: string;
  targetMode: string; packs: string[]; agencyIds: string[];
};

export function newAnnouncementPage(input: { chrome: Chrome; agencies: Agency[]; values?: AnnouncementForm; error?: string }): Html {
  const v: AnnouncementForm = input.values ?? { kind: 'feature', title: '', body: '', severity: 'info', audience: 'managers', startsAt: '', endsAt: '', ctaLabel: '', ctaUrl: '', targetMode: 'all', packs: [], agencyIds: [] };
  const live = input.agencies.filter((a) => a.status === 'active' || a.status === 'suspended');
  const KIND_HINT: Record<string, string> = { feature: 'Une fonctionnalité à faire connaître', maintenance: 'Une interruption prévue', info: 'Une information générale', billing: 'Facture, tarif, offre' };
  const body = html`
    <header class="page-head">
      <div><p class="crumbs"><a href="/news">Nouveautés</a> /</p><h1>Nouvelle annonce</h1>
        <p class="muted">Publiée dès l’envoi dans le panneau Nouveautés des CRM ciblés. Un avertissement s’affiche aussi en bandeau, à partir de 48 h avant sa date.</p></div>
      <div class="actions"><a class="btn btn-quiet" href="/news">Annuler</a><button class="btn btn-accent" type="submit" form="nw-ann">Publier l’annonce</button></div>
    </header>
    ${input.error ? html`<div class="notice notice-danger">${input.error}</div>` : ''}
    <div class="nw-split">
      <form method="post" action="/news/announcements" id="nw-ann" class="nw-editor" data-confirm="Publier cette annonce ? Elle part tout de suite vers les CRM ciblés.">
        ${csrfField(input.chrome.csrf)}
        <div class="nw-block">
          <fieldset class="nw-kinds"><legend>Type</legend>
            ${CATEGORIES.map((k) => html`<label class="nw-kind nw-kind-${CATEGORY_TONE[k]}"><input type="radio" name="kind" value="${k}" ${v.kind === k ? 'checked' : ''} data-pv="kind" />
              <span class="nw-kind-body">${icon(k === 'feature' ? 'sparkles' : k === 'maintenance' ? 'wrench' : k === 'billing' ? 'receipt' : 'info', 18)}<strong>${CATEGORY_LABELS[k]}</strong><small>${KIND_HINT[k]}</small></span></label>`)}
          </fieldset>
          <label>Titre <input name="title" value="${v.title}" maxlength="140" required placeholder="ex. Maintenance du CRM mardi soir" data-pv="title" /></label>
          <label>Texte <textarea name="body" rows="4" maxlength="4000" placeholder="Ce qu’il faut savoir, en quelques lignes." data-pv="summary">${v.body}</textarea></label>
        </div>
        <div class="nw-block">
          <div class="grid-2">
            <label><span class="nw-label">Début <span class="muted small">(heure de Paris, facultatif)</span></span><input type="datetime-local" name="startsAt" value="${v.startsAt}" data-pv="start" /></label>
            <label><span class="nw-label">Fin <span class="muted small">(l’annonce disparaît ensuite)</span></span><input type="datetime-local" name="endsAt" value="${v.endsAt}" data-pv="end" /></label>
          </div>
          <label class="check nw-warn-check"><input type="checkbox" name="severity" value="warning" ${v.severity === 'warning' ? 'checked' : ''} data-pv="severity" /> <span><strong>Avertissement</strong> — aussi en bandeau en haut du CRM, jusqu’à ce que chacun le ferme</span></label>
          <div class="grid-2">
            <label><span class="nw-label">Bouton <span class="muted small">(facultatif)</span></span><input name="ctaLabel" value="${v.ctaLabel}" maxlength="40" placeholder="ex. Voir la facturation" data-pv="cta" /></label>
            <label>Lien du bouton <input name="ctaUrl" value="${v.ctaUrl}" maxlength="500" placeholder="https://… ou /manager/billing" /></label>
          </div>
        </div>
        <div class="nw-block">
          <fieldset class="nw-seg"><legend>Visible par</legend><div class="nw-seg-track">
            ${(['managers', 'everyone'] as const).map((a) => html`<label class="nw-seg-opt"><input type="radio" name="audience" value="${a}" ${v.audience === a ? 'checked' : ''} /><span>${a === 'managers' ? 'Managers' : 'Toute l’équipe (hors clients)'}</span></label>`)}
          </div></fieldset>
          <fieldset class="nw-seg nw-target"><legend>Agences</legend><div class="nw-seg-track">
            ${[['all', 'Toutes'], ['packs', 'Par offre'], ['agencies', 'Choisir']].map(([m, l]) => html`<label class="nw-seg-opt"><input type="radio" name="targetMode" value="${m}" ${v.targetMode === m ? 'checked' : ''} data-target-mode /><span>${l}</span></label>`)}
          </div></fieldset>
          <div class="nw-target-panel" data-target-panel="packs" ${v.targetMode === 'packs' ? '' : 'hidden'}>
            ${PACKS.map((p) => html`<label class="check"><input type="checkbox" name="packs" value="${p.id}" ${v.packs.includes(p.id) ? 'checked' : ''} /> ${p.label} <span class="muted small">(${live.filter((a) => a.config.extra?.pack === p.id).length})</span></label>`)}
          </div>
          <div class="nw-target-panel" data-target-panel="agencies" ${v.targetMode === 'agencies' ? '' : 'hidden'}>
            ${live.map((a) => html`<label class="check"><input type="checkbox" name="agencyIds" value="${a.id}" ${v.agencyIds.includes(a.id) ? 'checked' : ''} /> ${a.name} <span class="muted small"><code>${a.imageTag ?? '—'}</code></span></label>`)}
          </div>
          <p class="small muted">${live.length} agence(s) en service. Celles dont le CRM est trop ancien recevront l’annonce après leur mise à jour.</p>
        </div>
      </form>
      <aside class="nw-preview-col" aria-label="Aperçu dans le CRM">
        <div class="nw-preview-sticky">
          <p class="nw-preview-label">${icon('eye', 15)} Aperçu dans le CRM</p>
          <div class="nw-crm-banner" data-preview="banner" ${v.severity === 'warning' ? '' : 'hidden'}>${icon('alert', 15)}<strong data-pv-out="title">${v.title || 'Titre de l’annonce'}</strong><span data-pv-out="when"></span><span class="nw-crm-banner-x">Détails</span></div>
          <div class="nw-crm">
            <div class="nw-crm-head"><strong>Nouveautés</strong><span>Ce qui change dans votre CRM, et ce qui arrive bientôt.</span></div>
            <article class="nw-crm-card" data-preview="announcement">
              <div class="nw-crm-meta"><span class="nw-crm-kind" data-pv-out="kind">${CATEGORY_LABELS[v.kind as keyof typeof CATEGORY_LABELS] ?? 'Nouveauté'}</span><span class="nw-crm-unread">Non lu</span><span class="nw-crm-date">aujourd’hui</span></div>
              <h3 data-pv-out="title">${v.title || 'Titre de l’annonce'}</h3>
              <p class="nw-crm-when" data-pv-out="when" hidden></p>
              <p data-pv-out="summary" ${v.body ? '' : 'hidden'}>${v.body}</p>
              <span class="nw-crm-cta" data-pv-out="cta" ${v.ctaLabel ? '' : 'hidden'}>${v.ctaLabel}</span>
            </article>
          </div>
        </div>
      </aside>
    </div>
    ${jsonScript('nw-labels', CATEGORY_LABELS)}`;
  return page('Nouvelle annonce', body, { ...input.chrome, active: 'news' }, { scripts: ['news.js'] });
}

export function announcementPage(input: { chrome: Chrome; announcement: Announcement; agencies: Agency[]; deliveries: (Delivery & { agencyName: string; agencySlug: string; agencyTag: string | null })[]; flash?: string }): Html {
  const { announcement: a, chrome } = input;
  const retracted = a.status === 'retracted';
  const body = html`
    <header class="page-head">
      <div>
        <p class="crumbs"><a href="/news">Nouveautés</a> / Annonces /</p>
        <h1>${a.title} ${retracted ? pill('Retirée', 'muted') : a.endsAt && a.endsAt < new Date() ? pill('Terminée', 'muted') : pill('En ligne', 'ok')}</h1>
        <p class="muted small">${catChip(a.kind)} · ${targetLabel(a, input.agencies)} · ${AUDIENCE_LABELS[a.audience]} · publiée le ${dateTime(a.publishedAt)}</p>
      </div>
      ${!retracted && can(chrome.role, 'announcement.send')
        ? html`<div class="actions"><form method="post" action="/news/announcements/${a.id}/retract" class="inline" data-confirm="Retirer cette annonce de tous les CRM ?">${csrfField(chrome.csrf)}<button class="btn btn-warn" type="submit">Retirer l’annonce</button></form></div>`
        : ''}
    </header>
    ${input.flash ? html`<div class="notice notice-ok">${input.flash}</div>` : ''}
    <section class="card nw-ann-detail">
      <dl class="kv">
        <dt>Texte</dt><dd class="nw-pre">${a.body || '—'}</dd>
        <dt>Quand</dt><dd>${windowLabel(a.startsAt, a.endsAt)}</dd>
        <dt>Importance</dt><dd>${a.severity === 'warning' ? html`${pill('Avertissement', 'warn')} <span class="small muted">bandeau en haut du CRM</span>` : 'Information'}</dd>
        <dt>Bouton</dt><dd>${a.ctaLabel ? html`${a.ctaLabel} → <code>${a.ctaUrl}</code>` : '—'}</dd>
      </dl>
    </section>
    <div class="section-bar"><div><h2>Envois</h2><p class="small muted">Une ligne par agence ciblée.</p></div></div>
    ${deliveriesTable(input.deliveries, chrome, 'announcement')}`;
  return page(a.title, body, { ...chrome, active: 'news' });
}
