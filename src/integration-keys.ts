// The two kinds of agency configuration, never mixed:
//   • fixed at creation: what the provisioning writes into the container env once (database,
//     generated secrets, address, bucket). Shown read-only; ENCRYPTION_KEY can never change.
//   • changeable: the agency's third-party keys (OpenAI, Allo, Serper…), stored encrypted in the
//     agency's own database through the signed /api/instance/integrations, live without a redeploy.
//     The CRM's catalog is lib/integrations/catalog.ts; this list must name the same keys.
//
// Key mode, per agency (config.extra.keys):
//   'agency'  → the platform's own values for these keys are left out of the agency's env: without
//               a key of its own, the feature is off. Every agency created by the wizard.
//   undefined → legacy: the shared file's values still reach the env (agencies created before).
//               "Passer aux clés de l'agence" copies them into the agency's store first, then flips.

import type { Agency } from './agencies.ts';

export const INTEGRATION_KEY_NAMES = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ALLO_API_KEY',
  'ALLO_WEBHOOK_SECRET',
  'MODJO_API_KEY',
  'CLAAP_API_KEY',
  'GRAIN_API_KEY',
  'FIREFLIES_API_KEY',
  'FATHOM_API_KEY',
  'TLDV_API_KEY',
  'SERPER_API_KEY',
  'APIFY_API_TOKEN',
  'APOLLO_API_KEY',
  'GOOGLE_PLACES_API_KEY',
  'MAPBOX_ACCESS_TOKEN',
  'SERP_API_KEY',
  'PAPPERS_API_KEY',
  'EXPLORIUM_API_KEY',
] as const;

const NAMES = new Set<string>(INTEGRATION_KEY_NAMES);

export const isIntegrationKey = (name: string) => NAMES.has(name);

export type KeyMode = 'agency' | 'legacy';

export const keyMode = (agency: Pick<Agency, 'config'>): KeyMode => (agency.config.extra?.keys === 'agency' ? 'agency' : 'legacy');

/** Per-agency, non-secret settings that may be set from the agency's record (config.extra.env). */
export const AGENCY_ENV_NAMES = ['AI_ALLOW_CN_RAW_CRM', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_RESIDENCY', 'OPENAI_ASSISTANT_MODEL', 'OPENAI_ASSISTANT_DEEP_MODEL', 'DEEPSEEK_MODEL_CHAT', 'DEEPSEEK_MODEL_REASONER'] as const;

/** The shared env an agency's container gets: without the integration keys in 'agency' mode, plus its own overrides. */
export function sharedEnvFor(agency: Pick<Agency, 'config'>, shared: Record<string, string>): Record<string, string> {
  const base = keyMode(agency) === 'legacy' ? shared : Object.fromEntries(Object.entries(shared).filter(([k]) => !NAMES.has(k)));
  const own = Object.entries(agency.config.extra?.env ?? {}).filter(([k, v]) => (AGENCY_ENV_NAMES as readonly string[]).includes(k) && v.trim() !== '');
  return { ...base, ...Object.fromEntries(own) };
}

/** What GET /api/instance/integrations returns per key (status only, never a value). */
export type InstanceKeyStatus = {
  name: string;
  label: string;
  group: 'ai' | 'telephony' | 'data';
  groupLabel: string;
  usedFor: string;
  placeholder: string | null;
  docsUrl: string | null;
  source: 'stored' | 'env' | 'none';
  hint: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** Same rule as the CRM (lib/integrations/catalog checkIntegrationValue), to answer before a round trip. */
export function keyValueProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Valeur vide.';
  if (v.length > 512) return '512 caractères maximum.';
  if (/\s/.test(v)) return 'Une clé ne contient ni espace ni retour à la ligne.';
  return null;
}
