import { html } from 'hono/html';
import type { Agency } from '../../agencies.ts';
import { can } from '../../roles.ts';
import type { Rollout, RolloutItem } from '../../rollouts.ts';
import { AGENCY_STATUS, JOB_STATUS, ago, bytes, dateTime, healthDot, healthReason, pill } from './format.ts';
import { avatar, mark } from './brand.ts';
import { csrfField, page, type Chrome, type Html } from './layout.ts';

function seats(a: Agency): Html {
  const used = a.health?.license?.seatsUsed;
  const limit = a.health?.license?.seatLimit ?? a.config.license?.seatLimit ?? null;
  if (used == null && limit == null) return html`<span class="muted">—</span>`;
  const over = used != null && limit != null && used > limit;
  return html`<span class="${over ? 'text-danger' : ''}">${used ?? '—'} / ${limit ?? '∞'}</span>`;
}

function healthCell(a: Agency, now: Date): Html {
  if (a.status === 'deleted') return html`<span class="muted">—</span>`;
  const title = a.healthOk == null ? 'Pas encore contrôlée' : a.healthOk ? `En ligne (${ago(a.healthCheckedAt, now)})` : `Hors ligne : ${healthReason(a.health?.error)}`;
  // One inline group: on a phone the cell is a flex row (label | value), the dot must stay with its word.
  return html`<span class="nowrap">${healthDot(a.healthOk, title)} <span class="small">${a.healthOk == null ? '—' : a.healthOk ? 'En ligne' : 'Hors ligne'}</span></span>`;
}

/** Summary tiles above the table: what an operator checks first thing in the morning. */
function summary(agencies: Agency[], live: Agency[], now: Date, versions: string[]): Html {
  const online = live.filter((a) => a.healthOk === true).length;
  const offline = live.filter((a) => a.healthOk === false).length;
  const used = live.reduce((n, a) => n + (a.health?.license?.seatsUsed ?? 0), 0);
  const limits = live.map((a) => a.health?.license?.seatLimit ?? a.config.license?.seatLimit ?? null);
  const cap = limits.every((l) => l != null) ? limits.reduce((n, l) => n + (l ?? 0), 0) : null;
  const backedUp = live.filter((a) => a.lastBackupAt && now.getTime() - new Date(a.lastBackupAt).getTime() < 36 * 3600_000).length;
  const tile = (label: string, value: string | number, foot: Html | string, tone = '') =>
    html`<div class="stat ${tone}">${tone === 'stat-accent' ? html`<span class="stat-mark">${mark(120)}</span>` : ''}<span class="stat-label">${label}</span><span class="stat-value">${value}</span><span class="stat-foot">${foot}</span></div>`;
  return html`<section class="stats" aria-label="Résumé">
    ${tile('Agences en service', live.length, `${agencies.length - live.length ? `${agencies.length - live.length} autre(s) (création, supprimée…)` : 'toutes actives ou suspendues'}`, 'stat-accent')}
    ${tile('En ligne', `${online}/${live.length}`, offline ? html`<span class="text-danger">${offline} hors ligne</span>` : 'aucune alerte de santé', offline ? 'stat-danger' : '')}
    ${tile('Utilisateurs', used, cap != null ? `sur ${cap} inclus` : 'au moins une offre illimitée')}
    ${tile('Sauvegardées < 36 h', `${backedUp}/${live.length}`, versions.length ? `versions : ${versions.join(', ')}` : '—', backedUp < live.length ? 'stat-warn' : '')}
  </section>`;
}

const ROLLOUT_STATUS: Record<Rollout['status'], { label: string; tone: string }> = {
  running: { label: 'En cours', tone: 'info' },
  succeeded: { label: 'Terminée', tone: 'ok' },
  failed: { label: 'Arrêtée sur un échec', tone: 'danger' },
  stopped: { label: 'Arrêtée', tone: 'muted' },
};

const ITEM_STATE: Record<RolloutItem['state'], { label: string; tone: string }> = {
  ...JOB_STATUS,
  todo: { label: 'À venir', tone: 'muted' },
  skipped: { label: 'Ignorée (hors service)', tone: 'muted' },
};

/** The fleet upgrade in progress (or finished in the last 24 h): one line per agency, in order. */
function rolloutCard(r: { rollout: Rollout; items: RolloutItem[] }, chrome: Chrome): Html {
  const { rollout } = r;
  const done = r.items.filter((i) => i.state === 'succeeded').length;
  const st = ROLLOUT_STATUS[rollout.status];
  const stoppable = (rollout.status === 'running' || rollout.status === 'failed') && can(chrome.role, 'agency.upgrade');
  return html`<section class="card rollout" aria-label="Mise à jour de la flotte">
    <div class="card-head"><h2>Mise à jour de la flotte vers <code>${rollout.tag}</code> ${pill(st.label, st.tone)}</h2>
      ${stoppable
        ? html`<form method="post" action="/rollouts/${rollout.id}/stop" class="inline" data-confirm="Arrêter la mise à jour de la flotte ? L’agence en cours termine la sienne, les suivantes ne sont pas touchées.">
            ${csrfField(chrome.csrf)}<button class="btn btn-small" type="submit">Arrêter</button></form>`
        : ''}</div>
    <p class="small muted">${done}/${r.items.length} à jour · une agence à la fois, arrêt au premier échec · lancée ${dateTime(rollout.createdAt)}</p>
    ${rollout.error ? html`<div class="notice notice-danger small">${rollout.error}<br />Relancez l’opération de cette agence : si elle réussit, la suite reprend.</div>` : ''}
    <ol class="rollout-list">${r.items.map((i) => {
      const s = ITEM_STATE[i.state];
      return html`<li><span>${i.slug ? html`<a href="/agencies/${i.slug}">${i.name}</a>` : i.name}</span> ${i.jobId ? html`<a href="/jobs/${i.jobId}">${pill(s.label, s.tone)}</a>` : pill(s.label, s.tone)}</li>`;
    })}</ol>
  </section>`;
}

export function fleetPage(input: { agencies: Agency[]; chrome: Chrome; now: Date; runningJobs: Map<string, string>; versions: string[]; rollout?: { rollout: Rollout; items: RolloutItem[] } | null }): Html {
  const { agencies, now } = input;
  const live = agencies.filter((a) => a.status === 'active' || a.status === 'suspended');
  const down = live.filter((a) => a.healthOk === false).length;
  const body = html`
    <header class="page-head">
      <div>
        <h1>Agences</h1>
        <p class="muted">Le CRM de chaque agence : santé, version, offre et sauvegardes.${down ? html` <span class="text-danger">${down} hors ligne.</span>` : ''}</p>
      </div>
      <div class="actions">
        ${live.length && can(input.chrome.role, 'agency.upgrade') ? html`<a class="btn" href="/fleet/upgrade">Mettre à jour la flotte</a>` : ''}
        ${can(input.chrome.role, 'agency.create') ? html`<a class="btn btn-accent" href="/agencies/new">Nouvelle agence</a>` : ''}
      </div>
    </header>
    ${agencies.length ? summary(agencies, live, now, input.versions) : ''}
    ${input.rollout ? rolloutCard(input.rollout, input.chrome) : ''}
    ${agencies.length
      ? html`<div class="table-wrap">
          <table class="table cards-sm">
            <thead>
              <tr><th>Agence</th><th>Adresse</th><th>État</th><th>Santé</th><th>Version</th><th>Utilisateurs</th><th>Stockage</th><th>Dernière sauvegarde</th></tr>
            </thead>
            <tbody>
              ${agencies.map((a) => {
                const st = AGENCY_STATUS[a.status];
                const job = input.runningJobs.get(a.id);
                return html`<tr>
                  <td class="nowrap"><a class="agency-cell" href="/agencies/${a.slug}">${avatar(a.name, a.slug)}<span><span class="strong">${a.name}</span><span class="small muted agency-slug">${a.slug}</span></span></a></td>
                  <td class="nowrap">${a.status === 'deleted' ? html`<span class="muted">${a.primaryHost}</span>` : html`<a href="https://${a.primaryHost}" target="_blank" rel="noopener">${a.primaryHost}</a>`}
                    ${a.domainPending ? html`<div class="small text-warn">${a.config.domain} : DNS en attente</div>` : ''}</td>
                  <td data-label="État">${pill(st.label, st.tone)}${job ? html`<div class="small muted">${job}…</div>` : ''}</td>
                  <td data-label="Santé">${healthCell(a, now)}</td>
                  <td data-label="Version"><code>${a.imageTag ?? '—'}</code></td>
                  <td data-label="Utilisateurs">${seats(a)}</td>
                  <td data-label="Stockage">${bytes(a.storageBytes)}</td>
                  <td data-label="Dernière sauvegarde" title="${dateTime(a.lastBackupAt)}">${a.status === 'deleted' ? '—' : ago(a.lastBackupAt, now)}</td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`
      : html`<div class="empty">
          <h2>Aucune agence pour l’instant</h2>
          <p class="muted">Créez la première : quelques minutes plus tard, elle a son CRM à son nom et son manager reçoit une invitation.</p>
          ${can(input.chrome.role, 'agency.create') ? html`<a class="btn btn-accent" href="/agencies/new">Créer une agence</a>` : ''}
        </div>`}`;
  return page('Agences', body, { ...input.chrome, active: 'fleet' });
}

export function fleetUpgradePage(input: { chrome: Chrome; agencies: Agency[]; defaultTag: string; error?: string }): Html {
  const live = input.agencies.filter((a) => a.status === 'active' || a.status === 'suspended');
  const body = html`
    <header class="page-head"><div><h1>Mettre à jour la flotte</h1>
      <p class="muted">Une agence à la fois, dans l’ordre de la liste : sauvegarde, migrations, redéploiement, contrôle. Si une version ne démarre pas, l’agence revient seule à sa version précédente et <strong>la mise à jour de la flotte s’arrête</strong> : les agences suivantes ne sont pas touchées.</p></div></header>
    ${input.error ? html`<div class="notice notice-danger">${input.error}</div>` : ''}
    <form method="post" action="/fleet/upgrade" class="card stack narrow">
      ${csrfField(input.chrome.csrf)}
      <label>Version (tag de l’image) <input name="tag" required pattern="[A-Za-z0-9_][A-Za-z0-9_.\\-]{0,127}" value="${input.defaultTag}" /></label>
      <fieldset class="checks"><legend>Agences</legend>
        ${live.map((a) => {
          // An agency already on the proposed version is left unticked: re-running it would only redeploy.
          const current = a.imageTag === input.defaultTag;
          return html`<label class="check"><input type="checkbox" name="agency" value="${a.id}" ${current ? '' : 'checked'} /> ${a.name} <span class="muted small">${current ? '(déjà sur cette version)' : `(actuellement ${a.imageTag ?? 'inconnue'})`}</span></label>`;
        })}
      </fieldset>
      <label>Commencer par <select name="first"><option value="">l’ordre alphabétique</option>${live.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
      <p class="small muted">Conseil : commencez par une agence de test (demo) ; si elle échoue, rien d’autre n’est touché.</p>
      <button class="btn btn-primary" type="submit">Lancer les mises à jour</button>
    </form>`;
  return page('Mettre à jour la flotte', body, { ...input.chrome, active: 'fleet' });
}
