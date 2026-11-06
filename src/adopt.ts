// Adopt an agency that was created outside the Console (npm run provision-agency in the CRM repo):
// register it in the fleet with its provisioning State sealed, so the Console can health-check,
// back up, upgrade, suspend and delete it like one it created itself.

import { createAgency, getAgency, updateAgency, type Agency } from './agencies.ts';
import type { Sealer } from './crypto.ts';
import type { Sql } from './db.ts';
import { validateAgencyConfig } from './provision/plan.ts';
import type { State } from './provision/run.ts';

export type AdoptInput = { state: unknown; config: unknown };

export class AdoptError extends Error {}

function checkState(raw: unknown): State {
  const s = raw as Partial<State> | null;
  if (!s || typeof s !== 'object') throw new AdoptError('state: un objet JSON est attendu (provision-out/<slug>.json)');
  for (const k of ['dbPassword', 'nextauthSecret', 'encryptionKey', 'instanceAdminSecret', 'cronSecret'] as const) {
    if (typeof s.secrets?.[k] !== 'string' || !s.secrets[k]) throw new AdoptError(`state.secrets.${k} manquant: ce n’est pas l’état d’un provisioning`);
  }
  if (typeof s.slug !== 'string' || typeof s.primaryHost !== 'string') throw new AdoptError('state.slug / state.primaryHost manquants');
  if (!s.dokployAppId) throw new AdoptError('state.dokployAppId manquant: l’agence n’a pas été déployée par provision-agency');
  return { ...(s as State), domains: s.domains?.length ? s.domains : [s.primaryHost], steps: s.steps ?? {} };
}

export async function adoptAgency(sql: Sql, sealer: Sealer, input: AdoptInput): Promise<Agency> {
  const parsed = validateAgencyConfig(input.config);
  if (!parsed.ok) throw new AdoptError('agency.json invalide:\n - ' + parsed.errors.join('\n - '));
  const state = checkState(input.state);
  if (state.slug !== parsed.value.slug) throw new AdoptError(`le slug de l’état (${state.slug}) et celui de agency.json (${parsed.value.slug}) diffèrent`);
  if (await getAgency(sql, state.slug)) throw new AdoptError(`${state.slug} est déjà dans la Console`);

  // Logos live in agency_logos for Console-created agencies; an adopted one keeps what the instance already has.
  const { logos: _logos, ...config } = parsed.value;
  const agency = await createAgency(sql, {
    config: config as never,
    primaryHost: state.primaryHost,
    imageTag: state.deployedTag ?? state.imageTag ?? 'unknown',
    logos: [],
    createdBy: null,
  });
  await updateAgency(sql, agency.id, {
    status: 'active',
    domains: state.domains,
    domainPending: Boolean(parsed.value.domain && state.primaryHost !== parsed.value.domain),
    stateEnc: sealer.seal(JSON.stringify(state)),
  });
  return (await getAgency(sql, agency.id))!;
}
