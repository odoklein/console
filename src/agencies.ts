// Agencies: the row the fleet page lists, plus the encrypted provisioning State (secrets,
// Dokploy id, tags) that the vendored provision() reads and writes through stateStore().

import type { Sealer } from './crypto.ts';
import type { Sql } from './db.ts';
import type { AgencyConfig, LogoSlot } from './provision/plan.ts';
import type { State } from './provision/run.ts';

/** What the wizard stores on top of AgencyConfig (not sent to the instance). */
export type AgencyExtra = {
  pack?: string;
  billing?: { name?: string; email?: string };
  legalName?: string;
  /** 'agency': integration keys come only from the agency's own store (src/integration-keys.ts). */
  keys?: 'agency';
  /** Non-secret env this agency alone gets (allowlist in src/integration-keys.ts), kept across upgrades. */
  env?: Record<string, string>;
};

export type StoredConfig = AgencyConfig & { extra?: AgencyExtra };

export type AgencyStatus = 'provisioning' | 'active' | 'failed' | 'suspended' | 'deleting' | 'deleted';

export type Agency = {
  id: string;
  slug: string;
  name: string;
  config: StoredConfig;
  status: AgencyStatus;
  primaryHost: string;
  domains: string[];
  domainPending: boolean;
  imageTag: string | null;
  stateEnc: string | null;
  health: HealthSnapshot | null;
  healthOk: boolean | null;
  healthCheckedAt: Date | null;
  healthFailures: number;
  storageBytes: string | null;
  lastBackupAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type HealthSnapshot = {
  version?: string;
  schemaVersion?: string | null;
  dbOk?: boolean;
  license?: { status?: string; plan?: string | null; seatLimit?: number | null; seatsUsed?: number | null };
  error?: string;
};

export type LogoUpload = { slot: LogoSlot; filename: string; contentType: string; data: Uint8Array };

export async function createAgency(
  sql: Sql,
  input: { config: StoredConfig; primaryHost: string; imageTag: string; logos: LogoUpload[]; createdBy: string | null },
): Promise<Agency> {
  return sql.begin(async (tx) => {
    const logos = Object.fromEntries(input.logos.map((l) => [l.slot, logoPath(l.slot, l.filename)]));
    const config: StoredConfig = { ...input.config, logos };
    const [row] = await tx<Agency[]>`
      INSERT INTO agencies (slug, name, config, primary_host, domains, image_tag, created_by)
      VALUES (${config.slug}, ${config.name}, ${tx.json(config as never)}, ${input.primaryHost}, ${[input.primaryHost]}, ${input.imageTag}, ${input.createdBy})
      RETURNING *`;
    for (const l of input.logos) {
      await tx`INSERT INTO agency_logos (agency_id, slot, filename, content_type, data) VALUES (${row!.id}, ${l.slot}, ${l.filename}, ${l.contentType}, ${Buffer.from(l.data)})`;
    }
    return row!;
  });
}

/** The vendored runner reads `${configDir}/${logos[slot]}`; the Console resolves that path to agency_logos. */
export const LOGO_DIR = 'db';
export function logoPath(slot: LogoSlot, filename: string): string {
  return `${slot}/${filename.replace(/[\\/]/g, '_')}`;
}

export async function readLogo(sql: Sql, agencyId: string, path: string): Promise<Uint8Array> {
  const slot = path.replace(new RegExp(`^${LOGO_DIR}/`), '').split('/')[0] ?? '';
  const [row] = await sql<{ data: Uint8Array }[]>`SELECT data FROM agency_logos WHERE agency_id = ${agencyId} AND slot = ${slot}`;
  if (!row) throw new Error(`logo ${slot} introuvable`);
  return row.data;
}

export async function getAgency(sql: Sql, idOrSlug: string): Promise<Agency | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const [row] = isUuid ? await sql<Agency[]>`SELECT * FROM agencies WHERE id = ${idOrSlug}` : await sql<Agency[]>`SELECT * FROM agencies WHERE slug = ${idOrSlug}`;
  return row ?? null;
}

export async function listAgencies(sql: Sql, opts: { includeDeleted?: boolean } = {}): Promise<Agency[]> {
  return opts.includeDeleted
    ? sql<Agency[]>`SELECT * FROM agencies ORDER BY name`
    : sql<Agency[]>`SELECT * FROM agencies WHERE status <> 'deleted' ORDER BY name`;
}

export async function updateAgency(sql: Sql, id: string, patch: Partial<Record<string, unknown>>): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const cols = Object.fromEntries(entries.map(([k, v]) => [k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), v]));
  await sql`UPDATE agencies SET ${sql(cols as Record<string, never>)}, updated_at = now() WHERE id = ${id}`;
}

export function readState(sealer: Sealer, agency: Pick<Agency, 'stateEnc'>): State | null {
  return agency.stateEnc ? (JSON.parse(sealer.open(agency.stateEnc)) as State) : null;
}

/** The store provision() expects, backed by agencies.state_enc. */
export function stateStore(sql: Sql, sealer: Sealer, agencyId: string) {
  return {
    async load(): Promise<State | null> {
      const [row] = await sql<{ stateEnc: string | null }[]>`SELECT state_enc FROM agencies WHERE id = ${agencyId}`;
      return row?.stateEnc ? (JSON.parse(sealer.open(row.stateEnc)) as State) : null;
    },
    async save(state: State): Promise<void> {
      await sql`UPDATE agencies SET state_enc = ${sealer.seal(JSON.stringify(state))}, primary_host = ${state.primaryHost}, domains = ${state.domains}, updated_at = now() WHERE id = ${agencyId}`;
    },
  };
}
