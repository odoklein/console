// Operator roles (docs/DEEP_CONTROL_PLAN.md §6.2). One table says who may do what; the routes ask
// can() and the pages hide what the role cannot do. Reading is open to every role.

export const ROLES = ['owner', 'operator', 'support', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Propriétaire',
  operator: 'Opérateur',
  support: 'Support',
  viewer: 'Lecture',
};

export const ROLE_HINTS: Record<Role, string> = {
  owner: 'Tout, y compris supprimer une agence, gérer l’équipe et télécharger la sauvegarde de la Console.',
  operator: 'Crée, met à jour, sauvegarde, restaure et règle les agences. Ne supprime pas, ne gère pas l’équipe.',
  support: 'Consulte tout, lance une sauvegarde, traite les alertes. Rien de destructif.',
  viewer: 'Consulte seulement.',
};

export type Permission =
  | 'agency.create'
  | 'agency.upgrade'
  | 'agency.backup'
  | 'agency.export'
  | 'agency.download'
  | 'agency.license'
  | 'agency.suspend'
  | 'agency.domain'
  | 'agency.keys'
  | 'agency.restore'
  | 'agency.delete'
  | 'job.manage'
  | 'alert.resolve'
  | 'platform.backup'
  | 'platform.download'
  | 'team.manage';

const OWNER_OPERATOR: Role[] = ['owner', 'operator'];

const MATRIX: Record<Permission, Role[]> = {
  'agency.create': OWNER_OPERATOR,
  'agency.upgrade': OWNER_OPERATOR,
  'agency.backup': ['owner', 'operator', 'support'],
  'agency.export': OWNER_OPERATOR,
  'agency.download': OWNER_OPERATOR,
  'agency.license': OWNER_OPERATOR,
  'agency.suspend': OWNER_OPERATOR,
  'agency.domain': OWNER_OPERATOR,
  'agency.keys': OWNER_OPERATOR,
  'agency.restore': OWNER_OPERATOR,
  'agency.delete': ['owner'],
  'job.manage': OWNER_OPERATOR,
  'alert.resolve': ['owner', 'operator', 'support'],
  'platform.backup': OWNER_OPERATOR,
  // The Console's dump holds every agency's sealed secrets.
  'platform.download': ['owner'],
  'team.manage': ['owner'],
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function can(role: Role | undefined, permission: Permission): boolean {
  return !!role && MATRIX[permission].includes(role);
}
