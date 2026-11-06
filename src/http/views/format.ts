import { html } from 'hono/html';
import type { AgencyStatus } from '../../agencies.ts';
import type { JobKind, JobStatus, StepResult } from '../../jobs/queue.ts';
import type { Html } from './layout.ts';

const TZ = 'Europe/Paris';

export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('fr-FR', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ago(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return 'jamais';
  const s = Math.round((now.getTime() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86_400)} j`;
}

export function bytes(n: number | string | null | undefined): string {
  if (n == null) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} o`;
  const fr = (x: number, d: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: d });
  if (v < 1_048_576) return `${fr(v / 1024, 0)} Ko`;
  if (v < 1_073_741_824) return `${fr(v / 1_048_576, 1)} Mo`;
  return `${fr(v / 1_073_741_824, 2)} Go`;
}

export const AGENCY_STATUS: Record<AgencyStatus, { label: string; tone: string }> = {
  provisioning: { label: 'Création en cours', tone: 'info' },
  active: { label: 'Active', tone: 'ok' },
  failed: { label: 'Création échouée', tone: 'danger' },
  suspended: { label: 'Suspendue', tone: 'warn' },
  deleting: { label: 'Suppression en cours', tone: 'danger' },
  deleted: { label: 'Supprimée', tone: 'muted' },
};

export const JOB_KIND: Record<JobKind, string> = {
  provision: 'Création de l’agence',
  domain: 'Domaine de l’agence',
  upgrade: 'Mise à jour',
  backup: 'Sauvegarde',
  restore: 'Restauration',
  restore_drill: 'Test de restauration',
  suspend: 'Suspension',
  resume: 'Réactivation',
  license: 'Changement d’offre',
  export: 'Export des données',
  delete: 'Suppression',
};

export const JOB_STATUS: Record<JobStatus, { label: string; tone: string }> = {
  queued: { label: 'En attente', tone: 'info' },
  running: { label: 'En cours', tone: 'info' },
  succeeded: { label: 'Terminé', tone: 'ok' },
  failed: { label: 'Échec', tone: 'danger' },
  canceled: { label: 'Annulé', tone: 'muted' },
};

export const STEP_ICON: Record<StepResult, string> = { todo: '○', running: '◌', done: '✓', pending: '◷', skipped: '–', failed: '✕' };

export function pill(label: string, tone: string): Html {
  return html`<span class="pill pill-${tone}">${label}</span>`;
}

export function healthDot(ok: boolean | null, title: string): Html {
  const tone = ok == null ? 'muted' : ok ? 'ok' : 'danger';
  return html`<span class="dot dot-${tone}" title="${title}" aria-label="${title}"></span>`;
}

export { healthReason } from '../../health-reason.ts';

/** Journal: readable labels for the action codes written by audit(). Unknown codes are shown as is. */
const AUDIT_LABELS: Record<string, string> = {
  login: 'Connexion',
  'operator.setup': 'Accès activé',
  'operator.create': 'Personne invitée',
  'operator.reset': 'Accès réinitialisé',
  'operator.disable': 'Accès désactivé',
  'operator.enable': 'Accès réactivé',
  'operator.role': 'Rôle changé',
  'session.revoke': 'Session fermée',
  'reauth.failed': 'Mot de passe de confirmation erroné',
  'rollout.start': 'Mise à jour de la flotte lancée',
  'rollout.stop': 'Mise à jour de la flotte arrêtée',
  'console.backup': 'Sauvegarde de la Console lancée',
  'console.download': 'Sauvegarde de la Console téléchargée',
  'agency.create': 'Agence créée',
  'alert.resolve': 'Alerte marquée résolue',
  'support.reply': 'Réponse à un ticket',
  'support.status': 'Statut d’un ticket changé',
  'support.priority': 'Priorité d’un ticket changée',
  'support.sync': 'Tickets synchronisés',
  'support.macro.create': 'Réponse type ajoutée',
  'support.macro.delete': 'Réponse type supprimée',
  'backup.download': 'Sauvegarde téléchargée',
  'export.download': 'Export téléchargé',
  'job.cancel': 'Opération annulée',
  'job.retry': 'Opération relancée',
};

export function auditLabel(action: string): string {
  if (AUDIT_LABELS[action]) return AUDIT_LABELS[action]!;
  const kind = action.startsWith('job.') ? (action.slice(4) as JobKind) : null;
  return kind && JOB_KIND[kind] ? `${JOB_KIND[kind]} lancée` : action;
}

/** What to do when a step fails, in plain words, next to the error. */
export const STEP_HINTS: Record<string, string> = {
  database: 'Le serveur Postgres n’accepte pas la création. Vérifiez PROVISION_PG_ADMIN_URL (droits CREATEROLE et CREATEDB), puis relancez.',
  storage: 'MinIO refuse la création du bucket ou de la clé. Vérifiez les accès MinIO et l’alias mc, puis relancez.',
  migrate: 'Les migrations n’ont pas pu tourner. Vérifiez que l’image de migration existe pour cette version et que la Console voit Docker et le réseau Postgres.',
  seed: 'Les données de référence n’ont pas pu être installées. Relancez ; si cela se répète, regardez le journal ci-dessous.',
  app: 'Dokploy a refusé une demande. Le message donne la route : comparez avec le Swagger de Dokploy.',
  route: 'La route publique n’a pas pu être écrite. Vérifiez que le dossier dynamique du proxy est monté dans la Console.',
  deploy: 'Dokploy n’a pas lancé le déploiement. Ouvrez l’application dans Dokploy pour voir son journal.',
  health: 'L’application ne répond pas. Le DNS, le certificat ou le démarrage peuvent prendre quelques minutes : relancez. Sinon, journal du conteneur dans Dokploy.',
  brand: 'L’instance a refusé la marque. Le message indique le champ en cause.',
  license: 'L’instance a refusé la licence. Vérifiez que ses migrations sont à jour.',
  logos: 'Un logo a été refusé (format PNG, SVG ou WebP attendu).',
  'custom-domain': 'Ajoutez l’enregistrement DNS indiqué chez le registrar de l’agence. La Console vérifie toute seule toutes les 5 minutes.',
  bootstrap: 'Le premier manager n’a pas pu être créé. Relancez.',
  backup: 'La sauvegarde a échoué : rien n’a été modifié. Relancez.',
  dump: 'pg_dump a échoué. Vérifiez que la Console joint Postgres.',
  rollback: 'Le retour à la version précédente a échoué : l’agence est probablement hors ligne. Intervention nécessaire dans Dokploy.',
  restore: 'La restauration a échoué et a été annulée en bloc : la base est restée telle qu’avant.',
};
