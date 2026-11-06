import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { can, ROLE_LABELS, type Role } from '../../roles.ts';
import { FAVICON, icon, mark } from './brand.ts';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export type Chrome = {
  operator?: { name: string; email: string } | null;
  /** The signed-in operator's role: pages hide what it cannot do (the routes refuse it anyway). */
  role?: Role;
  openAlerts?: number;
  active?: 'fleet' | 'new' | 'alerts' | 'platform' | 'team' | 'audit';
  csrf?: string;
};

/** JSON for a <script type="application/json"> block (no "</script>" breakout). */
export function jsonScript(id: string, value: unknown): Html {
  const text = JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return html`<script type="application/json" id="${id}">${raw(text)}</script>`;
}

/** Wordmark: the mark and the product name. */
export function brandLockup(size = 26): Html {
  return html`<span class="lockup">${mark(size)}<span class="lockup-text"><span class="lockup-name">Console</span><span class="lockup-sub">agences</span></span></span>`;
}

function nav(c: Chrome): Html {
  const item = (key: NonNullable<Chrome['active']>, href: string, label: string, badge?: number) =>
    html`<a href="${href}" class="nav-item${c.active === key ? ' is-active' : ''}" ${c.active === key ? html`aria-current="page"` : ''}>
      ${icon(key)}<span class="nav-label">${label}</span>${badge ? html`<span class="badge badge-danger">${badge}</span>` : ''}</a>`;
  const initials = c.operator?.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') ?? '';
  return html`<nav class="nav" aria-label="Navigation">
    <a href="/" class="brand">${brandLockup()}</a>
    <div class="nav-items">
      ${item('fleet', '/', 'Agences')} ${can(c.role, 'agency.create') ? item('new', '/agencies/new', 'Nouvelle agence') : ''} ${item('alerts', '/alerts', 'Alertes', c.openAlerts)}
      ${item('platform', '/platform', 'Plateforme')} ${item('team', '/team', 'Équipe')} ${item('audit', '/audit', 'Journal')}
    </div>
    ${c.operator
      ? html`<form method="post" action="/logout" class="nav-user">
          <input type="hidden" name="_csrf" value="${c.csrf ?? ''}" />
          <span class="nav-avatar" aria-hidden="true">${initials}</span>
          <span class="nav-who"><span class="nav-name">${c.operator.name}</span><span class="nav-email">${c.role ? ROLE_LABELS[c.role] : ''} · ${c.operator.email}</span></span>
          <button class="nav-logout" type="submit" title="Se déconnecter" aria-label="Se déconnecter">${icon('logout', 17)}</button>
        </form>`
      : ''}
  </nav>`;
}

export function page(title: string, body: Html, c: Chrome = {}, opts: { scripts?: string[]; bare?: boolean } = {}): Html {
  return html`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#0f0f12" />
        <title>${title} · Console agences</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" />
        <link rel="stylesheet" href="/static/app.css" />
        <link rel="icon" href="${FAVICON}" />
      </head>
      <body class="${opts.bare ? 'bare' : ''}">
        ${opts.bare ? '' : nav(c)}
        <main class="main">${body}</main>
        <script src="/static/common.js" defer></script>
        ${(opts.scripts ?? []).map((s) => html`<script src="/static/${s}" defer></script>`)}
      </body>
    </html>`;
}

/** Hidden CSRF field for every POST form. */
export function csrfField(token: string | undefined): Html {
  return html`<input type="hidden" name="_csrf" value="${token ?? ''}" />`;
}
