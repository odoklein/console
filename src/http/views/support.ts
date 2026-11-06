// Support inbox: three panes (views and agencies · tickets · the open ticket), one page, no client
// framework. Every action is a plain form; public/support.js adds keyboard shortcuts, drafts,
// auto-submit of the selects and a "new changes" banner.

import { html } from 'hono/html';
import { can } from '../../roles.ts';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  fieldLabel,
  filterQuery,
  PAGE_SIZE,
  PRIORITIES,
  PRIORITY_LABELS,
  ROLE_LABELS,
  SCOPE_LABELS,
  STATUS_LABELS,
  STATUSES,
  valueLabel,
  VIEW_HINTS,
  VIEW_LABELS,
  VIEWS,
  type AgencySupport,
  type InboxFilters,
  type InboxRow,
  type Macro,
  type RemoteTicket,
  type View,
} from '../../support.ts';
import { avatar, icon } from './brand.ts';
import { ago, dateTime, pill } from './format.ts';
import { csrfField, jsonScript, page, type Chrome, type Html } from './layout.ts';

export type SelectedTicket = {
  slug: string;
  agencyName: string;
  host: string;
  ticketId: string;
  result: { ok: true; ticket: RemoteTicket } | { ok: false; message: string };
};

export type InboxInput = {
  chrome: Chrome;
  filters: InboxFilters;
  views: Record<View, number>;
  agencies: AgencySupport[];
  rows: InboxRow[];
  total: number;
  selected: SelectedTicket | null;
  macros: Macro[];
  now: Date;
  /** Shown above the composer: the CRM refused, or the form was incomplete. */
  error?: string;
  /** What the operator typed, kept when the send failed. */
  draft?: { content: string; status: string };
  notice?: string;
};

const roleLabel = (r: string | null | undefined) => (r ? ROLE_LABELS[r] ?? r : '');
const ticketKey = (slug: string, id: string) => `${slug}/${id}`;

function statusPill(s: string): Html {
  const v = STATUS_LABELS[s] ?? { label: s, tone: 'muted' };
  return pill(v.label, v.tone);
}

function priorityPill(p: string): Html {
  const v = PRIORITY_LABELS[p] ?? { label: p, tone: 'muted' };
  return html`<span class="prio prio-${p.toLowerCase()}" title="Priorité ${v.label.toLowerCase()}">${v.label}</span>`;
}

// ---------- left: views and agencies ----------

function side(input: InboxInput): Html {
  const f = input.filters;
  const view = (v: View) => {
    const n = input.views[v];
    const tone = v === 'urgent' && n ? ' is-hot' : v === 'unread' && n ? ' is-unread' : '';
    return html`<a class="ib-view${f.view === v ? ' is-active' : ''}${tone}" href="/support${filterQuery({ ...f, view: v, page: 1 })}" title="${VIEW_HINTS[v]}" ${f.view === v ? html`aria-current="page"` : ''}>
      <span>${VIEW_LABELS[v]}</span><span class="ib-count">${n}</span></a>`;
  };
  const visible = VIEWS.filter((v) => v !== 'done' && v !== 'all');
  return html`<aside class="ib-side" aria-label="Vues et agences">
    <nav class="ib-group" aria-label="Vues">
      <p class="ib-title">Vues</p>
      ${visible.map(view)}
      <details class="ib-more" ${f.view === 'done' || f.view === 'all' ? 'open' : ''}><summary>Plus</summary>${view('done')}${view('all')}</details>
    </nav>
    <nav class="ib-group" aria-label="Agences">
      <p class="ib-title">Agences</p>
      <a class="ib-agency${!f.agency ? ' is-active' : ''}" href="/support${filterQuery({ ...f, agency: null, page: 1 })}"><span class="ib-agency-name">Toutes les agences</span></a>
      ${input.agencies.map(
        (a) => html`<a class="ib-agency${f.agency === a.slug ? ' is-active' : ''}" href="/support${filterQuery({ ...f, agency: a.slug, page: 1 })}" title="${a.error ? `Synchronisation : ${a.error}` : a.syncedAt ? `Synchronisée ${ago(a.syncedAt, input.now)}` : 'Pas encore synchronisée'}">
          <span class="ib-avatar">${avatar(a.name, a.slug)}</span>
          <span class="ib-agency-name">${a.name}</span>
          ${a.error ? html`<span class="dot dot-danger" aria-label="Synchronisation en échec"></span>` : a.urgent ? html`<span class="ib-count is-hot" title="${a.urgent} urgent(s)">${a.urgent}</span>` : ''}
          <span class="ib-count">${a.open}</span></a>`,
      )}
      ${input.agencies.length ? '' : html`<p class="small muted ib-empty-side">Aucune agence en service.</p>`}
    </nav>
  </aside>`;
}

// ---------- middle: the list ----------

function filterBar(input: InboxInput): Html {
  const f = input.filters;
  const opt = (value: string, label: string, current: string | null) => html`<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
  return html`<form class="ib-filters" method="get" action="/support" role="search" data-autosubmit>
    <input type="hidden" name="view" value="${f.view}" />
    ${f.agency ? html`<input type="hidden" name="agency" value="${f.agency}" />` : ''}
    <label class="ib-search"><span class="sr-only">Rechercher</span>
      <input type="search" name="q" value="${f.q ?? ''}" placeholder="Rechercher… (titre, agence, TC-0012)" autocomplete="off" data-search /><kbd>/</kbd></label>
    <div class="ib-selects">
      <label><span class="sr-only">Statut</span><select name="status">${opt('', 'Statut', f.status)}${STATUSES.map((s) => opt(s, STATUS_LABELS[s]!.label, f.status))}</select></label>
      <label><span class="sr-only">Priorité</span><select name="priority">${opt('', 'Priorité', f.priority)}${PRIORITIES.map((s) => opt(s, PRIORITY_LABELS[s]!.label, f.priority))}</select></label>
      <label><span class="sr-only">Type</span><select name="category">${opt('', 'Type', f.category)}${CATEGORIES.map((s) => opt(s, CATEGORY_LABELS[s]!, f.category))}</select></label>
      <noscript><button class="btn btn-small" type="submit">Filtrer</button></noscript>
    </div>
  </form>`;
}

function row(r: InboxRow, input: InboxInput): Html {
  const f = input.filters;
  const key = ticketKey(r.agencySlug, r.ticketId);
  const active = input.selected && ticketKey(input.selected.slug, input.selected.ticketId) === key;
  const open = r.status !== 'COMPLETED' && r.validation !== 'REJECTED';
  const overdue = open && r.dueDate && new Date(r.dueDate).getTime() < input.now.getTime();
  const unanswered = open && r.validation !== 'PENDING' && !r.lastPlatformReplyAt;
  return html`<li><a class="tk${r.unread ? ' is-unread' : ''}${active ? ' is-active' : ''}${r.priority === 'URGENT' && open ? ' is-urgent' : ''}" href="/support${filterQuery({ ...f, t: key })}" data-row ${active ? html`aria-current="true"` : ''}>
    <span class="tk-avatar">${avatar(r.agencyName, r.agencySlug)}</span>
    <span class="tk-main">
      <span class="tk-top"><span class="tk-agency">${r.agencyName}</span><span class="tk-ref">${r.ref}</span><time class="tk-time" datetime="${new Date(r.updatedAt).toISOString()}" title="${dateTime(r.updatedAt)}">${ago(r.updatedAt, input.now).replace('il y a ', '')}</time></span>
      <span class="tk-title">${r.unread ? html`<span class="tk-dot" aria-label="Non lu"></span>` : ''}${r.title}</span>
      ${r.preview ? html`<span class="tk-preview">${r.preview}</span>` : ''}
      <span class="tk-meta">
        ${r.priority === 'HIGH' || r.priority === 'URGENT' ? priorityPill(r.priority) : ''}
        ${r.validation === 'PENDING' ? pill('À valider', 'warn') : statusPill(r.status)}
        ${overdue ? html`<span class="tk-flag tk-flag-danger">En retard</span>` : ''}
        ${unanswered ? html`<span class="tk-flag" title="Aucune réponse du support plateforme">Sans réponse</span>` : ''}
        <span class="tk-who">${r.requesterName ?? '—'}${r.requesterRole ? html` <span class="muted">· ${roleLabel(r.requesterRole)}</span>` : ''}</span>
        ${r.comments ? html`<span class="tk-stat" title="${r.comments} message(s)">${icon('chat', 13)}${r.comments}</span>` : ''}
        ${r.attachments ? html`<span class="tk-stat" title="${r.attachments} pièce(s) jointe(s)">${icon('clip', 13)}${r.attachments}</span>` : ''}
      </span>
    </span></a></li>`;
}

function list(input: InboxInput): Html {
  const f = input.filters;
  const broken = input.agencies.filter((a) => a.error && (!f.agency || f.agency === a.slug));
  const never = input.agencies.length > 0 && input.agencies.every((a) => !a.syncedAt);
  const pages = Math.max(1, Math.ceil(input.total / PAGE_SIZE));
  const title = f.agency ? input.agencies.find((a) => a.slug === f.agency)?.name ?? f.agency : VIEW_LABELS[f.view];
  return html`<section class="ib-list" aria-label="Tickets">
    <div class="ib-list-head">
      <div class="ib-list-title"><h2>${title}${f.agency ? html` <span class="muted ib-sub">· ${VIEW_LABELS[f.view]}</span>` : ''}</h2><span class="muted small">${input.total} ticket${input.total > 1 ? 's' : ''}</span></div>
      ${filterBar(input)}
    </div>
    <div id="ib-fresh" class="ib-fresh" hidden><span>Il y a du nouveau.</span> <a href="" data-reload>Actualiser</a></div>
    ${broken.map(
      (a) => html`<div class="ib-warn small"><strong>${a.name}</strong> : ${a.error}
        ${a.errorAt ? html`<span class="muted">(${ago(a.errorAt, input.now)})</span>` : ''} Les tickets affichés datent de la dernière synchronisation réussie.</div>`,
    )}
    ${input.rows.length
      ? html`<ul class="tk-list" id="tk-list">${input.rows.map((r) => row(r, input))}</ul>
          ${pages > 1
            ? html`<nav class="ib-pages small" aria-label="Pages">
                ${f.page > 1 ? html`<a class="btn btn-small" href="/support${filterQuery({ ...f, page: f.page - 1 })}">Précédents</a>` : html`<span></span>`}
                <span class="muted">Page ${f.page} sur ${pages}</span>
                ${f.page < pages ? html`<a class="btn btn-small" href="/support${filterQuery({ ...f, page: f.page + 1 })}">Suivants</a>` : html`<span></span>`}
              </nav>`
            : ''}`
      : html`<div class="ib-empty">
          <span class="ib-empty-mark">${icon('support', 34)}</span>
          ${never
            ? html`<h3>Première synchronisation en attente</h3><p class="muted">Les tickets des agences arrivent dans les 2 minutes. Vous pouvez aussi lancer la synchronisation maintenant.</p>`
            : f.view === 'open' && !f.agency && !f.q && !f.status && !f.priority && !f.category
              ? html`<h3>Aucun ticket ouvert dans la flotte</h3><p class="muted">Toutes les demandes des agences sont traitées.</p>`
              : html`<h3>Rien dans cette vue</h3><p class="muted">Aucun ticket ne correspond à ces filtres.</p><a class="btn btn-small" href="/support">Effacer les filtres</a>`}
        </div>`}
  </section>`;
}

// ---------- right: the ticket ----------

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

function message(input: { name: string; role?: string | null; platform: boolean; at: string; content: string; now: Date; first?: boolean }): Html {
  return html`<li class="msg${input.platform ? ' is-platform' : ''}${input.first ? ' is-first' : ''}">
    <span class="msg-avatar" aria-hidden="true">${input.platform ? icon('support', 15) : initials(input.name)}</span>
    <div class="msg-body">
      <div class="msg-head"><span class="msg-name">${input.name}</span>${input.role && !input.platform ? html`<span class="msg-role">${roleLabel(input.role)}</span>` : ''}${input.platform && input.name !== 'Support plateforme' ? html`<span class="msg-role">Support plateforme</span>` : ''}${input.first ? html`<span class="msg-role">a ouvert le ticket</span>` : ''}
        <time datetime="${input.at}" title="${dateTime(input.at)}">${ago(input.at, input.now)}</time></div>
      <div class="msg-text">${input.content}</div>
    </div></li>`;
}

function thread(t: RemoteTicket, now: Date): Html {
  return html`<ol class="thread" id="thread">
    ${message({ name: t.requester?.name ?? 'Demandeur', role: t.requester?.role, platform: false, at: t.createdAt, content: t.description || 'Pas de description.', now, first: true })}
    ${t.thread.map((i) =>
      i.kind === 'comment'
        ? message({ name: i.author.name, role: i.author.role, platform: i.author.platform, at: i.at, content: i.content, now })
        : i.field === 'created'
          ? ''
          : html`<li class="evt"><span class="evt-line"></span><span class="evt-text"><strong>${i.author.platform ? 'Support plateforme' : i.author.name}</strong> · ${fieldLabel(i.field)} :
              ${valueLabel(i.field, i.from)} → <strong>${valueLabel(i.field, i.to)}</strong> · <time datetime="${i.at}" title="${dateTime(i.at)}">${ago(i.at, now)}</time></span></li>`,
    )}
  </ol>`;
}

function hiddenFilters(f: InboxFilters): Html {
  return html`${f.view !== 'open' ? html`<input type="hidden" name="view" value="${f.view}" />` : ''}
    ${(['agency', 'status', 'priority', 'category', 'q'] as const).map((k) => (f[k] ? html`<input type="hidden" name="f_${k}" value="${f[k]}" />` : ''))}
    ${f.page > 1 ? html`<input type="hidden" name="page" value="${f.page}" />` : ''}`;
}

function details(t: RemoteTicket, sel: SelectedTicket): Html {
  const checks = t.releaseChecks;
  return html`<details class="tk-details"${checks.length || t.attachments.length ? ' open' : ''}>
    <summary>Détails</summary>
    <dl class="kv small">
      <dt>Type</dt><dd>${CATEGORY_LABELS[t.category] ?? t.category} · ${SCOPE_LABELS[t.scope] ?? t.scope}</dd>
      <dt>Demandeur</dt><dd>${t.requester?.name ?? '—'}${t.requester ? html` <span class="muted">(${roleLabel(t.requester.role)})</span>` : ''}</dd>
      <dt>Assigné à</dt><dd>${t.assignee ? html`${t.assignee.name} <span class="muted">(${roleLabel(t.assignee.role)})</span>` : html`<span class="muted">personne</span>`}</dd>
      ${t.client ? html`<dt>Client</dt><dd>${t.client.name}</dd>` : ''}
      ${t.mission ? html`<dt>Mission</dt><dd>${t.mission.name}</dd>` : ''}
      <dt>Créé</dt><dd>${dateTime(t.createdAt)}</dd>
      ${t.dueDate ? html`<dt>Échéance</dt><dd class="${t.overdue ? 'text-danger' : ''}">${dateTime(t.dueDate)}${t.overdue ? ' · en retard' : ''}</dd>` : ''}
      ${t.completedAt ? html`<dt>Terminé</dt><dd>${dateTime(t.completedAt)}</dd>` : ''}
    </dl>
    ${checks.length
      ? html`<p class="tk-sub">Tests avant mise en ligne</p><ul class="plain small checks-list">${checks.map(
          (c) => html`<li class="${c.checked ? 'text-ok' : 'muted'}">${c.checked ? '✓' : '○'} ${roleLabel(c.role)}${c.checkedBy ? html` <span class="muted">· ${c.checkedBy}</span>` : ''}</li>`,
        )}</ul>`
      : ''}
    ${t.attachments.length
      ? html`<p class="tk-sub">Pièces jointes <span class="muted">(à ouvrir dans le CRM)</span></p><ul class="plain small">${t.attachments.map((a) => html`<li>${icon('clip', 13)} ${a.name}</li>`)}</ul>`
      : ''}
    <p class="small"><a href="https://${sel.host}/manager/tickets?ticket=${t.id}" target="_blank" rel="noopener">Ouvrir dans le CRM de ${sel.agencyName} ↗</a></p>
  </details>`;
}

function composer(input: InboxInput, sel: SelectedTicket, t: RemoteTicket): Html {
  const f = input.filters;
  const action = `/support/t/${sel.slug}/${t.id}`;
  if (!can(input.chrome.role, 'support.reply')) {
    return html`<div class="composer composer-ro small muted">Votre rôle permet de lire les tickets, pas d’y répondre.</div>`;
  }
  const draft = input.draft;
  const statusOpts = t.allowedStatuses.filter((s) => s !== t.status);
  return html`<form class="composer" method="post" action="${action}" data-composer data-key="${ticketKey(sel.slug, t.id)}">
    ${csrfField(input.chrome.csrf)}${hiddenFilters(f)}
    <input type="hidden" name="action" value="comment" />
    ${input.error ? html`<div class="notice notice-danger small composer-error" role="alert">${input.error}</div>` : ''}
    <label class="sr-only" for="reply">Réponse</label>
    <textarea id="reply" name="content" rows="3" maxlength="10000" placeholder="Répondre à ${t.requester?.name ?? 'l’agence'}…" title="r pour écrire, ⌘/Ctrl + Entrée pour envoyer" data-reply>${draft?.content ?? ''}</textarea>
    <div class="composer-bar">
      ${input.macros.length
        ? html`<label class="composer-macro"><span class="sr-only">Réponse type</span><select data-macro><option value="">Réponses types…</option>${input.macros.map((m) => html`<option value="${m.id}">${m.title}</option>`)}</select></label>`
        : html`<a class="small muted" href="/support/macros">Créer des réponses types</a>`}
      ${statusOpts.length
        ? html`<label class="composer-status"><span class="small muted">puis</span><select name="status" aria-label="Changer le statut en envoyant"><option value="">statut inchangé</option>${statusOpts.map(
            (s) => html`<option value="${s}" ${draft?.status === s ? 'selected' : ''}>→ ${STATUS_LABELS[s]?.label ?? s}</option>`,
          )}</select></label>`
        : ''}
      <span class="grow"></span>
      <span class="small muted composer-sign" title="Votre nom est ajouté à la fin du message dans le CRM">Signé ${input.chrome.operator?.name ?? ''}</span>
      <button class="btn btn-accent" type="submit" title="⌘/Ctrl + Entrée">Envoyer</button>
    </div>
    ${jsonScript('macros-data', Object.fromEntries(input.macros.map((m) => [m.id, m.body])))}
  </form>`;
}

function controls(input: InboxInput, sel: SelectedTicket, t: RemoteTicket): Html {
  const f = input.filters;
  const action = `/support/t/${sel.slug}/${t.id}`;
  if (!can(input.chrome.role, 'support.reply')) return html`<div class="tk-controls">${statusPill(t.status)} ${priorityPill(t.priority)}</div>`;
  const options = [t.status, ...t.allowedStatuses.filter((s) => s !== t.status)];
  return html`<div class="tk-controls">
    <form method="post" action="${action}" class="inline" data-autosubmit>
      ${csrfField(input.chrome.csrf)}${hiddenFilters(f)}<input type="hidden" name="action" value="status" />
      <label class="ctl"><span class="ctl-label">Statut</span><select name="status" aria-label="Statut">${options.map((s) => html`<option value="${s}" ${s === t.status ? 'selected' : ''}>${STATUS_LABELS[s]?.label ?? s}</option>`)}</select></label>
      <noscript><button class="btn btn-small" type="submit">OK</button></noscript>
    </form>
    <form method="post" action="${action}" class="inline" data-autosubmit>
      ${csrfField(input.chrome.csrf)}${hiddenFilters(f)}<input type="hidden" name="action" value="priority" />
      <label class="ctl"><span class="ctl-label">Priorité</span><select name="priority" aria-label="Priorité" class="sel-prio sel-${t.priority.toLowerCase()}">${PRIORITIES.map((s) => html`<option value="${s}" ${s === t.priority ? 'selected' : ''}>${PRIORITY_LABELS[s]!.label}</option>`)}</select></label>
      <noscript><button class="btn btn-small" type="submit">OK</button></noscript>
    </form>
    ${t.validation === 'PENDING' ? pill('À valider par l’agence', 'warn') : ''}
  </div>`;
}

function pane(input: InboxInput): Html {
  const sel = input.selected;
  if (!sel) {
    return html`<section class="ib-pane ib-pane-empty" aria-label="Ticket">
      <div class="ib-empty">
        <span class="ib-empty-mark">${icon('support', 34)}</span>
        <h3>Choisissez un ticket</h3>
        <p class="muted">La conversation s’ouvre ici. Vos réponses arrivent dans le CRM de l’agence, signées de votre nom.</p>
        <p class="small muted kbd-help"><kbd>j</kbd> <kbd>k</kbd> naviguer · <kbd>Entrée</kbd> ouvrir · <kbd>/</kbd> rechercher · <kbd>r</kbd> répondre</p>
      </div></section>`;
  }
  const back = html`<a class="ib-back" href="/support${filterQuery({ ...input.filters })}">← Tickets</a>`;
  if (!sel.result.ok) {
    return html`<section class="ib-pane" aria-label="Ticket">${back}
      <div class="ib-empty"><h3>Ticket indisponible</h3><p class="muted">${sel.result.message}</p>
        <a class="btn btn-small" href="/support${filterQuery({ ...input.filters, t: ticketKey(sel.slug, sel.ticketId) })}">Réessayer</a></div></section>`;
  }
  const t = sel.result.ticket;
  return html`<section class="ib-pane" aria-label="Ticket ${t.ref}">
    ${back}
    <header class="tk-head">
      <p class="tk-crumbs"><a class="tk-agency-link" href="/agencies/${sel.slug}">${avatar(sel.agencyName, sel.slug)}<span>${sel.agencyName}</span></a><span class="tk-ref">${t.ref}</span>
        <span class="muted small">${CATEGORY_LABELS[t.category] ?? t.category}</span></p>
      <h2 class="tk-h">${t.title}</h2>
      ${controls(input, sel, t)}
    </header>
    ${input.notice ? html`<div class="notice notice-ok small">${input.notice}</div>` : ''}
    <div class="tk-scroll" data-thread>
      ${thread(t, input.now)}
      ${details(t, sel)}
    </div>
    ${composer(input, sel, t)}
  </section>`;
}

export function supportPage(input: InboxInput): Html {
  const f = input.filters;
  const latest = input.rows.reduce((m, r) => Math.max(m, new Date(r.updatedAt).getTime()), 0);
  const head = html`<header class="page-head ib-head">
    <div><h1>Support</h1><p class="muted">Les tickets Support Technique de toutes les agences. Vos réponses arrivent dans leur CRM.</p></div>
    <div class="actions">
      <a class="btn" href="/support/macros">Réponses types</a>
      ${can(input.chrome.role, 'support.reply')
        ? html`<form method="post" action="/support/sync" class="inline">${csrfField(input.chrome.csrf)}${hiddenFilters(f)}<button class="btn" type="submit" title="Synchronise toutes les agences maintenant (sinon toutes les 2 minutes)">${icon('refresh', 16)} Synchroniser</button></form>`
        : ''}
    </div>
  </header>`;
  const body = html`${head}
    <div class="inbox${input.selected ? ' has-ticket' : ''}">
      ${side(input)}
      ${list(input)}
      ${pane(input)}
    </div>
    ${jsonScript('support-data', { latest, view: f.view, sent: Boolean(input.notice), key: input.selected ? ticketKey(input.selected.slug, input.selected.ticketId) : null })}`;
  return page(input.selected?.result.ok ? `${input.selected.result.ticket.ref} · Support` : 'Support', body, { ...input.chrome, active: 'support' }, { scripts: ['support.js'] });
}

// ---------- canned replies ----------

export function macrosPage(input: { chrome: Chrome; macros: Macro[]; error?: string; values?: { title: string; body: string } }): Html {
  const may = can(input.chrome.role, 'support.reply');
  const body = html`
    <header class="page-head"><div><p class="crumbs"><a href="/support">Support</a> /</p><h1>Réponses types</h1>
      <p class="muted">Des réponses prêtes à l’emploi, partagées par toute l’équipe. Dans un ticket, choisissez-en une : elle s’insère dans la réponse, que vous pouvez adapter avant d’envoyer.</p></div></header>
    <div class="grid-2-even">
      <section class="card">
        <h2>${input.macros.length} réponse${input.macros.length > 1 ? 's' : ''} type${input.macros.length > 1 ? 's' : ''}</h2>
        ${input.macros.length
          ? html`<ul class="macro-list">${input.macros.map(
              (m) => html`<li class="macro">
                <div class="macro-head"><strong>${m.title}</strong>
                  ${may
                    ? html`<form method="post" action="/support/macros/${m.id}/delete" class="inline" data-confirm="Supprimer la réponse type « ${m.title} » ?">${csrfField(input.chrome.csrf)}<button class="btn btn-small btn-quiet" type="submit">Supprimer</button></form>`
                    : ''}</div>
                <p class="macro-body small">${m.body}</p>
                <p class="small muted">${m.createdByName ? `${m.createdByName} · ` : ''}${dateTime(m.createdAt)}</p></li>`,
            )}</ul>`
          : html`<p class="muted">Aucune pour l’instant. Commencez par celles que vous tapez le plus souvent : accusé de réception, demande de capture d’écran, correctif déployé.</p>`}
      </section>
      ${may
        ? html`<form method="post" action="/support/macros" class="card stack">
            <h2>Nouvelle réponse type</h2>
            ${csrfField(input.chrome.csrf)}
            ${input.error ? html`<div class="notice notice-danger small">${input.error}</div>` : ''}
            <label>Titre <input name="title" maxlength="80" required value="${input.values?.title ?? ''}" placeholder="Correctif déployé" /></label>
            <label>Texte <textarea name="body" rows="7" maxlength="10000" required placeholder="Bonjour, le correctif est en ligne depuis ce matin…">${input.values?.body ?? ''}</textarea></label>
            <div><button class="btn btn-primary" type="submit">Ajouter</button></div>
          </form>`
        : ''}
    </div>`;
  return page('Réponses types', body, { ...input.chrome, active: 'support' });
}
