import { html } from 'hono/html';
import { FEATURE_LABELS, FONTS, PACKS, TIME_ZONES, type Features } from '../../packs.ts';
import { csrfField, jsonScript, page, type Chrome, type Html } from './layout.ts';

export type WizardValues = Partial<Record<string, string>>;

const LOGO_FIELDS: { slot: string; label: string; hint: string }[] = [
  { slot: 'full', label: 'Logo complet', hint: 'Sur fond clair (barre latérale, emails)' },
  { slot: 'fullInverse', label: 'Logo complet, version claire', hint: 'Sur fond foncé (page de connexion)' },
  { slot: 'mark', label: 'Symbole', hint: 'Carré, barre latérale repliée' },
  { slot: 'favicon', label: 'Icône d’onglet', hint: 'Carré, 64 px ou plus' },
];

function field(name: string, label: string, v: WizardValues, attrs: { type?: string; required?: boolean; placeholder?: string; hint?: string; pattern?: string } = {}): Html {
  return html`<label class="field">
    <span>${label}${attrs.required ? html` <span class="req" aria-hidden="true">*</span>` : ''}</span>
    <input name="${name}" type="${attrs.type ?? 'text'}" value="${v[name] ?? ''}" ${attrs.required ? 'required' : ''}
      placeholder="${attrs.placeholder ?? ''}" ${attrs.pattern ? html`pattern="${attrs.pattern}"` : ''} />
    ${attrs.hint ? html`<small class="muted">${attrs.hint}</small>` : ''}
  </label>`;
}

export function wizardPage(input: { chrome: Chrome; platformDomain: string; values?: WizardValues; errors?: string[] }): Html {
  const v = input.values ?? {};
  const pack = v.pack ?? 'equipe';
  const body = html`
    <header class="page-head"><div><h1>Nouvelle agence</h1><p class="muted">Cinq étapes. Rien n’est créé avant la dernière.</p></div></header>
    ${input.errors?.length
      ? html`<div class="notice notice-danger" role="alert"><strong>À corriger :</strong><ul>${input.errors.map((e) => html`<li>${e}</li>`)}</ul>
          <p class="small">Les logos sont à sélectionner de nouveau.</p></div>`
      : ''}
    <form method="post" action="/agencies" enctype="multipart/form-data" class="wizard" id="wizard" novalidate data-fresh="${input.values ? '0' : '1'}">
      ${csrfField(input.chrome.csrf)}
      <ol class="wizard-steps" aria-label="Étapes">
        <li data-step="1" class="is-current">Agence</li><li data-step="2">Marque</li><li data-step="3">Adresse web</li><li data-step="4">Offre</li><li data-step="5">Lancer</li>
      </ol>

      <section class="wizard-panel card" data-panel="1">
        <h2>L’agence</h2>
        <div class="grid-2">
          ${field('name', 'Nom de l’agence', v, { required: true, placeholder: 'ex. Agence Nord' })}
          <label class="field"><span>Nom court <span class="req" aria-hidden="true">*</span></span>
            <input name="slug" value="${v.slug ?? ''}" required pattern="[a-z][a-z0-9\\-]{1,30}[a-z0-9]" placeholder="ex. agence-nord" autocomplete="off" />
            <small class="muted" id="slug-help">Sert pour l’adresse, la base et le stockage. Minuscules, chiffres, tirets.</small></label>
          ${field('legalName', 'Raison sociale', v, { placeholder: 'ex. Agence Nord SAS' })}
          <label class="field"><span>Fuseau horaire</span>
            <select name="timeZone">${TIME_ZONES.map((t) => html`<option value="${t.id}" ${v.timeZone === t.id ? 'selected' : ''}>${t.label}</option>`)}</select></label>
        </div>
        <h3>Premier manager</h3>
        <p class="small muted">Il reçoit l’invitation par email et crée lui-même son mot de passe.</p>
        <div class="grid-2">
          ${field('managerName', 'Nom et prénom', v, { required: true })}
          ${field('managerEmail', 'Email', v, { required: true, type: 'email' })}
        </div>
      </section>

      <section class="wizard-panel card" data-panel="2" hidden>
        <h2>Marque</h2>
        <div class="brand-layout">
          <div class="stack">
            <div class="grid-2">
              <label class="field"><span>Couleur principale</span><span class="color-row"><input type="color" name="primaryColor" value="${v.primaryColor ?? '#1f3a5f'}" /><code data-echo="primaryColor"></code></span></label>
              <label class="field"><span>Couleur d’accent</span><span class="color-row"><input type="color" name="accentColor" value="${v.accentColor ?? '#e4572e'}" /><code data-echo="accentColor"></code></span></label>
            </div>
            <div class="notice notice-warn" id="contrast-warning" hidden></div>
            <label class="field"><span>Police</span>
              <select name="fontPreset">${FONTS.map((f) => html`<option value="${f.id}" ${v.fontPreset === f.id ? 'selected' : ''}>${f.label}</option>`)}</select></label>
            <div class="grid-2">
              ${LOGO_FIELDS.map(
                (l) => html`<label class="field"><span>${l.label}</span><input type="file" name="logo_${l.slot}" accept="image/png,image/svg+xml,image/webp" data-logo="${l.slot}" />
                  <small class="muted">${l.hint}. PNG, SVG ou WebP, 1 Mo max.</small></label>`,
              )}
            </div>
            <p class="small muted">Sans logo, ceux de la plateforme restent. On peut les changer plus tard depuis le CRM (Paramètres, Identité).</p>
          </div>
          <div class="preview" id="brand-preview" aria-label="Aperçu">
            <div class="pv-app">
              <div class="pv-side"><div class="pv-logo" data-pv="logo">${v.name || 'Agence'}</div><div class="pv-item is-on">Accueil</div><div class="pv-item">Prospects</div><div class="pv-item">Rendez-vous</div></div>
              <div class="pv-body"><div class="pv-title">Bonjour</div><div class="pv-card"><span class="pv-chip">Nouveau</span><div class="pv-line"></div><div class="pv-line short"></div><span class="pv-btn">Appeler</span></div></div>
            </div>
            <div class="pv-login"><div class="pv-login-card"><div class="pv-logo-dark" data-pv="logo-inverse">${v.name || 'Agence'}</div><div class="pv-input"></div><div class="pv-input"></div><span class="pv-btn wide">Se connecter</span></div></div>
          </div>
        </div>
      </section>

      <section class="wizard-panel card" data-panel="3" hidden>
        <h2>Adresse web</h2>
        <label class="option"><input type="radio" name="addressMode" value="platform" ${v.addressMode !== 'own' ? 'checked' : ''} />
          <span><strong>Immédiate</strong><br /><code data-slug-host>${v.slug || 'nom-court'}.${input.platformDomain}</code><br /><small class="muted">Fonctionne tout de suite.</small></span></label>
        <label class="option"><input type="radio" name="addressMode" value="own" ${v.addressMode === 'own' ? 'checked' : ''} />
          <span><strong>Domaine de l’agence</strong><br /><small class="muted">L’agence démarre sur l’adresse immédiate, et bascule seule sur son domaine dès que le DNS est prêt.</small></span></label>
        <div class="own-domain" ${v.addressMode === 'own' ? '' : 'hidden'}>
          ${field('domain', 'Domaine', v, { placeholder: 'ex. crm.agence-nord.fr' })}
          <div class="dns-line"><span>À transmettre à l’agence (son registrar) :</span>
            <div class="copy-row"><code id="dns-record">CNAME <span data-domain>${v.domain || 'crm.agence-nord.fr'}</span> → edge.${input.platformDomain}</code><button class="btn btn-small" type="button" data-copy="#dns-record">Copier</button></div></div>
        </div>
      </section>

      <section class="wizard-panel card" data-panel="4" hidden>
        <h2>Offre</h2>
        <div class="packs">
          ${PACKS.map(
            (p) => html`<label class="pack"><input type="radio" name="pack" value="${p.id}" ${pack === p.id ? 'checked' : ''} />
              <span class="pack-body"><strong>${p.label}</strong><span class="small muted">${p.summary}</span>
              <span class="pack-seats">${p.seats ?? '—'} <small>utilisateurs</small></span></span></label>`,
          )}
        </div>
        <div class="grid-2">
          <label class="field"><span>Utilisateurs inclus</span><input type="number" name="seatLimit" min="1" max="10000" value="${v.seatLimit ?? ''}" placeholder="illimité" />
            <small class="muted">Utilisateurs actifs, hors portail client. Vide = illimité.</small></label>
          <label class="field"><span>Quota IA mensuel (requêtes)</span><input type="number" name="aiMonthlyQuota" min="0" value="${v.aiMonthlyQuota ?? ''}" placeholder="illimité" /></label>
        </div>
        <fieldset class="checks"><legend>Options</legend>
          ${(Object.keys(FEATURE_LABELS) as (keyof Features)[]).map(
            (k) => html`<label class="check"><input type="checkbox" name="feature_${k}" value="1" ${v[`feature_${k}`] ? 'checked' : ''} /> ${FEATURE_LABELS[k]}</label>`,
          )}
        </fieldset>
        <h3>Contact facturation</h3>
        <div class="grid-2">${field('billingName', 'Nom', v)} ${field('billingEmail', 'Email', v, { type: 'email' })}</div>
      </section>

      <section class="wizard-panel card" data-panel="5" hidden>
        <h2>Lancer</h2>
        <dl class="recap" id="recap"></dl>
        <p class="muted">La création prend quelques minutes. Vous suivez chaque étape en direct, et toute étape en échec peut être relancée.</p>
      </section>

      <div class="wizard-nav">
        <button type="button" class="btn" data-prev hidden>Retour</button>
        <span class="grow"></span>
        <button type="button" class="btn btn-primary" data-next>Continuer</button>
        <button type="submit" class="btn btn-accent" data-submit hidden>Créer l’agence</button>
      </div>
    </form>
    ${jsonScript('wizard-data', { packs: PACKS, platformDomain: input.platformDomain, fonts: FONTS, featureLabels: FEATURE_LABELS })}`;
  return page('Nouvelle agence', body, { ...input.chrome, active: 'new' }, { scripts: ['wizard.js'] });
}
