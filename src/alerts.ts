// Operator alerts: one open alert per (agency, key), shown in the Console and sent once
// (email and/or Slack). Resolving sends a short "back to normal" note.

import type { Sql } from './db.ts';
import type { Notifier } from './infra/types.ts';
import { log } from './log.ts';

export type Alert = {
  id: string;
  agencyId: string | null;
  kind: string;
  key: string;
  message: string;
  openedAt: Date;
  notifiedAt: Date | null;
  resolvedAt: Date | null;
};

export async function openAlert(
  sql: Sql,
  notify: Notifier,
  input: { agencyId: string | null; agencyName?: string; kind: string; key: string; message: string },
): Promise<void> {
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM alerts WHERE agency_id IS NOT DISTINCT FROM ${input.agencyId} AND key = ${input.key} AND resolved_at IS NULL`;
  if (existing) {
    await sql`UPDATE alerts SET message = ${input.message} WHERE id = ${existing.id}`;
    return;
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO alerts (agency_id, kind, key, message) VALUES (${input.agencyId}, ${input.kind}, ${input.key}, ${input.message})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!row) return; // opened concurrently
  const subject = input.agencyName ? `${input.agencyName} : ${input.message.split('\n')[0]}` : input.message.split('\n')[0]!;
  try {
    if (await notify.alert(subject, input.message)) await sql`UPDATE alerts SET notified_at = now() WHERE id = ${row.id}`;
  } catch (err) {
    log.warn('alert.notify_failed', { error: String(err) });
  }
}

export async function resolveAlert(sql: Sql, notify: Notifier, input: { agencyId: string | null; agencyName?: string; key: string; message?: string }): Promise<void> {
  const rows = await sql<{ id: string; notifiedAt: Date | null }[]>`
    UPDATE alerts SET resolved_at = now()
    WHERE agency_id IS NOT DISTINCT FROM ${input.agencyId} AND key = ${input.key} AND resolved_at IS NULL
    RETURNING id, notified_at`;
  if (rows.some((r) => r.notifiedAt) && input.message) {
    await notify.alert(input.agencyName ? `${input.agencyName} : ${input.message}` : input.message, input.message).catch(() => false);
  }
}

export async function openAlerts(sql: Sql): Promise<(Alert & { agencyName: string | null; agencySlug: string | null })[]> {
  return sql`
    SELECT a.*, g.name AS agency_name, g.slug AS agency_slug FROM alerts a LEFT JOIN agencies g ON g.id = a.agency_id
    WHERE a.resolved_at IS NULL ORDER BY a.opened_at DESC`;
}

export async function recentAlerts(sql: Sql, limit = 50): Promise<(Alert & { agencyName: string | null; agencySlug: string | null })[]> {
  return sql`
    SELECT a.*, g.name AS agency_name, g.slug AS agency_slug FROM alerts a LEFT JOIN agencies g ON g.id = a.agency_id
    ORDER BY a.opened_at DESC LIMIT ${limit}`;
}
