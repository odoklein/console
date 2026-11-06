import { html } from 'hono/html';
import { mark } from './brand.ts';
import { brandLockup, csrfField, page, type Html } from './layout.ts';

/** Sign-in, setup and message pages: the mark large on the ink panel, the form on paper. */
function card(title: string, body: Html, lead?: string): Html {
  return html`<div class="auth">
    <aside class="auth-aside" aria-hidden="true">
      <div class="auth-aside-mark">${mark(200)}</div>
      <div class="auth-aside-text">
        <p class="auth-kicker">Console agences</p>
        <p class="auth-tagline">Créer, surveiller et mettre à jour les CRM de chaque agence, depuis un seul endroit.</p>
      </div>
    </aside>
    <div class="auth-main">
      <div class="auth-card">
        <div class="auth-brand">${brandLockup(30)}</div>
        <h1>${title}</h1>
        ${lead ? html`<p class="muted">${lead}</p>` : ''} ${body}
      </div>
    </div>
  </div>`;
}

const error = (msg?: string) => (msg ? html`<div class="notice notice-danger" role="alert">${msg}</div>` : '');

export function loginPage(input: { error?: string; email?: string }): Html {
  return page(
    'Connexion',
    card(
      'Connexion',
      html`${error(input.error)}
        <form method="post" action="/login" class="stack">
          <label>Email <input type="email" name="email" required autocomplete="username" value="${input.email ?? ''}" autofocus /></label>
          <label>Mot de passe <input type="password" name="password" required autocomplete="current-password" /></label>
          <button class="btn btn-primary" type="submit">Continuer</button>
        </form>`,
    ),
    {},
    { bare: true },
  );
}

export function setupPage(input: { name: string; error?: string; token: string }): Html {
  return page(
    'Créer votre accès',
    card(
      `Bienvenue ${input.name}`,
      html`${error(input.error)}
        <form method="post" action="/setup/${input.token}" class="stack">
          <label>Choisissez un mot de passe <input type="password" name="password" minlength="12" required autocomplete="new-password" autofocus /></label>
          <label>Confirmez-le <input type="password" name="confirm" minlength="12" required autocomplete="new-password" /></label>
          <p class="small muted">12 caractères minimum.</p>
          <button class="btn btn-primary" type="submit">Enregistrer</button>
        </form>`,
      'Ce lien sert une seule fois.',
    ),
    {},
    { bare: true },
  );
}

/** Unknown address: same card as the auth pages, with a way back. */
export function notFoundPage(): Html {
  return page('Page introuvable', card('Page introuvable', html`<p>Cette adresse ne correspond à rien dans la Console : l’agence a peut-être été renommée ou supprimée.</p><p><a class="btn btn-primary" href="/">Retour aux agences</a></p>`), {}, { bare: true });
}

export function messagePage(title: string, message: string): Html {
  return page(title, card(title, html`<p>${message}</p><p><a href="/login">Aller à la connexion</a></p>`), {}, { bare: true });
}
