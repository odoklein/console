// Commercial packs offered in the wizard. Seats = active non-client users (the CRM's own
// count). The figures are a starting point to edit here, not a price list: the wizard lets
// the operator override seats and options for any agency.

export type Features = { callVault: boolean; aiAssistant: boolean; whiteLabel: boolean; agent: boolean };

export type Pack = { id: string; label: string; summary: string; seats: number | null; aiMonthlyQuota: number | null; features: Features };

export const PACKS: Pack[] = [
  { id: 'essentiel', label: 'Essentiel', summary: 'Petite équipe, sans coffre d’appels', seats: 5, aiMonthlyQuota: 500, features: { callVault: false, aiAssistant: true, whiteLabel: true, agent: false } },
  { id: 'equipe', label: 'Équipe', summary: 'Le plus courant', seats: 12, aiMonthlyQuota: 2000, features: { callVault: false, aiAssistant: true, whiteLabel: true, agent: false } },
  { id: 'agence', label: 'Agence', summary: 'Grande équipe, coffre d’appels inclus', seats: 30, aiMonthlyQuota: null, features: { callVault: true, aiAssistant: true, whiteLabel: true, agent: true } },
  { id: 'sur-mesure', label: 'Sur mesure', summary: 'Tout se règle à la main', seats: null, aiMonthlyQuota: null, features: { callVault: false, aiAssistant: true, whiteLabel: true, agent: false } },
];

export const FEATURE_LABELS: Record<keyof Features, string> = {
  callVault: 'Coffre d’appels (transcriptions)',
  aiAssistant: 'Assistant IA',
  whiteLabel: 'Marque blanche (logo et couleurs)',
  agent: 'Agent Captain (tâches automatiques en arrière-plan)',
};

export function packById(id: string | undefined): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

export const TIME_ZONES: { id: string; label: string; locale: string; currency: string }[] = [
  { id: 'Europe/Paris', label: 'France (Paris)', locale: 'fr-FR', currency: 'EUR' },
  { id: 'Europe/Brussels', label: 'Belgique (Bruxelles)', locale: 'fr-BE', currency: 'EUR' },
  { id: 'Europe/Zurich', label: 'Suisse (Zurich)', locale: 'fr-CH', currency: 'CHF' },
  { id: 'Europe/Luxembourg', label: 'Luxembourg', locale: 'fr-LU', currency: 'EUR' },
  { id: 'America/Montreal', label: 'Canada (Montréal)', locale: 'fr-CA', currency: 'CAD' },
  { id: 'Africa/Casablanca', label: 'Maroc (Casablanca)', locale: 'fr-MA', currency: 'MAD' },
  { id: 'Indian/Antananarivo', label: 'Madagascar (Antananarivo)', locale: 'fr-MG', currency: 'MGA' },
  { id: 'Indian/Reunion', label: 'La Réunion', locale: 'fr-RE', currency: 'EUR' },
];

export const FONTS: { id: string; label: string; css: string }[] = [
  { id: 'default', label: 'Bricolage Grotesque + Geist', css: "'Bricolage Grotesque', system-ui, sans-serif" },
  { id: 'inter', label: 'Inter', css: "'Inter', system-ui, sans-serif" },
  { id: 'manrope', label: 'Manrope', css: "'Manrope', system-ui, sans-serif" },
];
