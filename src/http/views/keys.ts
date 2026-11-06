import { html } from 'hono/html';
import type { Agency } from '../../agencies.ts';
import type { InstanceKeyStatus, KeyMode } from '../../integration-keys.ts';
import { can } from '../../roles.ts';
import { dateTime, pill } from './format.ts';
import { csrfField, page, type Chrome, type Html } from './layout.ts';

// /agencies/:slug/keys — the agency's configuration in three bands, from most frozen to most alive:
// fixed at creation (container env, never edited here), platform (shared by every agency, edited
// in the Console's shared file), and the agency's own keys (live, encrypted in its database).

export type FixedItem = { name: string; label: string; value: Html | string; note?: string; sealed?: boolean };

export type KeysView = {
  chrome: Chrome;
  agency: Agency;
  mode: KeyMode;
  fixed: FixedItem[];
  platform: { name: string; withheld: boolean }[];
  /** null when the instance could not be asked (down, old version): reason in `instanceError`. */
  keys: InstanceKeyStatus[] | null;
  instanceError?: string;
  /** Legacy agencies: keys the instance still reads from its env and the Console can carry over. */
  adoptable: string[];
  flash?: { tone: 'ok' | 'danger'; text: string };
  /** Key whose form reopens with an error after a failed save. */
  openKey?: string;
};

const GROUP_ORDER = ['ai', 'telephony', 'data'] as const;

function sourceBadge(k: InstanceKeyStatus): Html {
  if (k.source === 'stored') return pill('Clé de l’agence', 'ok');
  if (k.source === 'env') return pill('Valeur d’origine', 'warn');
  return pill('Désactivée', 'muted');
}

function keyRow(v: KeysView, k: InstanceKeyStatus): Html {
  const a = v.agency;
  const meta = k.source === 'stored'
    ? [k.updatedBy, k.updatedAt ? dateTime(new Date(k.updatedAt)) : null].filter(Boolean).join(' · ')
    : k.source === 'env' ? 'écrite dans le conteneur à la création' : 'aucune clé : la fonction est coupée';
  return html`<li class="key-row" id="k-${k.name}">
    <div class="key-main">
      <div class="key-title"><strong>${k.label}</strong> ${sourceBadge(k)} ${k.hint ? html`<code class="key-hint">${k.hint}</code>` : ''}</div>
      <p class="small muted key-use">${k.usedFor}</p>
      <p class="small key-meta"><code>${k.name}</code> · ${meta}</p>
    </div>
    ${can(v.chrome.role, 'agency.keys') ? html`<div class="key-actions">
      ${k.source === 'stored'
        ? html`<form method="post" action="/agencies/${a.slug}/keys" class="inline" data-confirm="Retirer la clé ${k.label} de ${a.name} ? Sans autre valeur, la fonction sera coupée.">
            ${csrfField(v.chrome.csrf)}<input type="hidden" name="name" value="${k.name}" /><input type="hidden" name="remove" value="1" />
            <button class="btn btn-small btn-quiet" type="submit">Retirer</button></form>`
        : ''}
      <a class="btn btn-small key-open" href="#edit-${k.name}">${k.source === 'none' ? 'Ajouter' : 'Remplacer'}</a>
    </div>
    <form method="post" action="/agencies/${a.slug}/keys" id="edit-${k.name}" class="key-form ${v.openKey === k.name ? 'is-open' : ''}">
      ${csrfField(v.chrome.csrf)}<input type="hidden" name="name" value="${k.name}" />
      <label class="sr-only" for="v-${k.name}">${k.label}</label>
      <input id="v-${k.name}" name="value" type="password" required autocomplete="off" spellcheck="false" placeholder="${k.placeholder ?? 'Collez la clé'}" />
      <a class="btn btn-small btn-quiet-plain" href="#k-${k.name}">Annuler</a>
      <button class="btn btn-primary btn-small" type="submit">Enregistrer</button>
      ${k.docsUrl ? html`<a class="small key-docs" href="${k.docsUrl}" target="_blank" rel="noopener noreferrer">Où trouver cette clé</a>` : ''}
    </form>` : ''}
  </li>`;
}

export function keysPage(v: KeysView): Html {
  const a = v.agency;
  const head = html`<header class="page-head">
    <div>
      <p class="crumbs"><a href="/">Agences</a> / <a href="/agencies/${a.slug}">${a.name}</a> /</p>
      <h1>Clés & configuration</h1>
      <p class="muted">Ce qui est figé à la création, ce qui vient de la plateforme, et les clés que l’agence peut changer à tout moment.</p>
    </div>
  </header>`;

  const flash = v.flash ? html`<div class="notice notice-${v.flash.tone === 'ok' ? 'ok' : 'danger'}" role="status">${v.flash.text}</div>` : '';

  const legacy = v.mode === 'legacy'
    ? html`<section class="card band band-warn">
        <div class="band-body">
          <h2>Cette agence reçoit encore les clés de la plateforme</h2>
          <p>Créée avant la séparation : ${v.adoptable.length
            ? html`<strong>${v.adoptable.join(', ')}</strong> arrivent par son environnement, depuis le fichier commun.`
            : 'les clés d’intégration du fichier commun arrivent par son environnement.'}
          En passant aux clés de l’agence, les valeurs actuelles sont d’abord copiées dans sa base (rien ne s’arrête),
          puis la plateforme cesse de les fournir à la prochaine mise à jour.</p>
        </div>
        ${can(v.chrome.role, 'agency.keys')
          ? html`<form method="post" action="/agencies/${a.slug}/keys/adopt" data-confirm="Passer ${a.name} aux clés de l’agence ?">
              ${csrfField(v.chrome.csrf)}<button class="btn btn-accent" type="submit" ${v.keys ? '' : 'disabled'}>Passer aux clés de l’agence</button>
            </form>`
          : ''}
      </section>`
    : '';

  const live = v.keys
    ? GROUP_ORDER.map((g) => {
        const items = v.keys!.filter((k) => k.group === g);
        if (!items.length) return '';
        const on = items.filter((k) => k.source !== 'none').length;
        return html`<div class="key-group">
          <div class="key-group-head"><h3>${items[0]!.groupLabel}</h3><span class="small muted">${on}/${items.length} actives</span></div>
          <ul class="key-list">${items.map((k) => keyRow(v, k))}</ul>
        </div>`;
      })
    : html`<div class="notice notice-warn">${v.instanceError ?? 'L’instance ne répond pas.'}</div>`;

  const changeable = html`<section class="card tier tier-live">
    <div class="tier-head">
      <span class="tier-tag">Modifiable</span>
      <div><h2>Clés de l’agence</h2>
        <p class="small muted">Chiffrées dans la base de l’agence avec sa clé de chiffrement. Actives en quelques secondes, sans redéploiement.
          Le manager de l’agence peut aussi les changer dans <em>Paramètres → Intégrations</em>. Aucune valeur n’est jamais réaffichée.</p></div>
    </div>
    ${live}
  </section>`;

  const fixed = html`<section class="card tier tier-fixed">
    <div class="tier-head">
      <span class="tier-tag">Figé à la création</span>
      <div><h2>Identité de l’instance</h2>
        <p class="small muted">Écrit une fois dans le conteneur. Ne se modifie pas d’ici : la clé de chiffrement scelle les clés de l’agence et ses connexions email.</p></div>
    </div>
    <dl class="fixed-list">${v.fixed.map(
      (f) => html`<div class="fixed-item">
        <dt>${f.label} <code class="small muted">${f.name}</code></dt>
        <dd>${f.sealed ? html`<span class="sealed">scellé</span>` : f.value}${f.note ? html`<span class="small muted fixed-note">${f.note}</span>` : ''}</dd>
      </div>`,
    )}</dl>
  </section>`;

  const platform = html`<section class="card tier tier-platform">
    <div class="tier-head">
      <span class="tier-tag">Plateforme</span>
      <div><h2>Commun à toutes les agences</h2>
        <p class="small muted">Fichier commun de la Console (SMTP, applications OAuth, relais). Un changement atteint l’agence à sa prochaine mise à jour.</p></div>
    </div>
    ${v.platform.length
      ? html`<ul class="chips">${v.platform.map((s) => html`<li class="chip ${s.withheld ? 'chip-off' : ''}" title="${s.withheld ? 'Non transmise : l’agence utilise sa propre clé' : 'Transmise à l’agence'}"><code>${s.name}</code></li>`)}</ul>
        ${v.platform.some((s) => s.withheld) ? html`<p class="small muted">Barrées : clés d’intégration que la plateforme ne transmet pas à cette agence.</p>` : ''}`
      : html`<p class="muted">Aucune.</p>`}
  </section>`;

  return page(`Clés · ${a.name}`, html`${head}${flash}${legacy}${changeable}<div class="grid-2-even">${fixed}${platform}</div>`, { ...v.chrome, active: 'fleet' });
}
