// Support inbox: the Support Technique tickets of every agency CRM, handled from the Console.
//
// The CRM is the source of truth. Each instance answers the signed API documented in the CRM repo
// (docs/CONSOLE_SUPPORT.md):
//   GET  /api/instance/support/tickets      list, filters, keyset paging, updatedSince, counters
//   GET  /api/instance/support/tickets/:id  one ticket and its thread (comments + history)
//   POST /api/instance/support/tickets/:id  { action: comment | status | priority, … }
// The scheduler keeps support_tickets (a cache) fresh every 2 minutes; a ticket is always read
// live when an operator opens it, so the conversation on screen is never stale.

import { listAgencies, readState, type Agency } from './agencies.ts';
import { openAlert, resolveAlert } from './alerts.ts';
import type { Sql } from './db.ts';
import { healthReason } from './health-reason.ts';
import { instanceApi } from './jobs/ops.ts';
import { errorFields, log } from './log.ts';
import type { Platform } from './platform.ts';

export const SYNC_EVERY_MS = 2 * 60_000;
export const FULL_SYNC_EVERY_MS = 24 * 3_600_000;
const PAGE = 200;
const MAX_PAGES = 50;
const LIVE = new Set(['active', 'suspended']);

export const TICKET_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- vocabulary (same enums as the CRM) ----------

export const STATUSES = ['NEW', 'TODO', 'IN_PROGRESS', 'BLOCKED', 'TESTING', 'COMPLETED'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const CATEGORIES = ['BUG', 'IMPROVEMENT', 'FEATURE_REQUEST', 'TECHNICAL_SUPPORT'] as const;
export type TicketStatus = (typeof STATUSES)[number];
export type TicketPriority = (typeof PRIORITIES)[number];

export const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  NEW: { label: 'Nouveau', tone: 'info' },
  TODO: { label: 'À faire', tone: 'muted' },
  IN_PROGRESS: { label: 'En cours', tone: 'info' },
  BLOCKED: { label: 'Bloqué', tone: 'danger' },
  TESTING: { label: 'En test', tone: 'warn' },
  COMPLETED: { label: 'Terminé', tone: 'ok' },
};
export const PRIORITY_LABELS: Record<string, { label: string; tone: string }> = {
  LOW: { label: 'Basse', tone: 'muted' },
  MEDIUM: { label: 'Moyenne', tone: 'info' },
  HIGH: { label: 'Haute', tone: 'warn' },
  URGENT: { label: 'Urgente', tone: 'danger' },
};
export const CATEGORY_LABELS: Record<string, string> = {
  BUG: 'Bug',
  IMPROVEMENT: 'Amélioration',
  FEATURE_REQUEST: 'Fonctionnalité',
  TECHNICAL_SUPPORT: 'Support technique',
};
export const SCOPE_LABELS: Record<string, string> = { INTERNAL: 'Interne', CLIENT_FACING: 'Visible client', MISSION_RELATED: 'Mission' };
export const ROLE_LABELS: Record<string, string> = {
  SDR: 'SDR',
  BOOKER: 'Booker',
  MANAGER: 'Manager',
  CLIENT: 'Client',
  DEVELOPER: 'Développeur',
  BUSINESS_DEVELOPER: 'Business developer',
  COMMERCIAL: 'Commercial',
};
const FIELD_LABELS: Record<string, string> = { status: 'statut', priority: 'priorité', assignee: 'assignation', scope: 'portée', created: 'création' };

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** History values are enum codes; show their labels when we know them. */
export function valueLabel(field: string, value: string | null): string {
  if (value == null || value === '') return '—';
  if (field === 'status') return STATUS_LABELS[value]?.label ?? value;
  if (field === 'priority') return PRIORITY_LABELS[value]?.label ?? value;
  return value;
}

// ---------- the CRM's shapes ----------

export type RemoteSummary = {
  id: string;
  number: number;
  ref: string;
  title: string;
  preview: string | null;
  category: string;
  scope: string;
  priority: string;
  status: string;
  validation: string;
  dueDate: string | null;
  overdue: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requester: { name: string; role: string } | null;
  assignee: { name: string; role: string } | null;
  client: { name: string } | null;
  comments: number;
  attachments: number;
  /** Last comment by the platform account. Sent by CRM images from 2026-11-06 on; absent from older ones. */
  lastPlatformReplyAt?: string | null;
};

export type ThreadItem =
  | { kind: 'comment'; id: string; at: string; author: { name: string; role: string; platform: boolean }; content: string }
  | { kind: 'event'; id: string; at: string; author: { name: string; role: string; platform: boolean }; field: string; from: string | null; to: string | null };

/** The detail: `attachments` is the list of files here, where a list row only counts them. */
export type RemoteTicket = Omit<RemoteSummary, 'attachments'> & {
  description: string | null;
  mission: { name: string } | null;
  attachments: { id: string; name: string; mimeType: string; size: number; createdAt: string }[];
  releaseChecks: { role: string; checked: boolean; checkedBy: string | null; checkedAt: string | null }[];
  allowedStatuses: string[];
  thread: ThreadItem[];
};

export type SupportCounts = { open: number; new: number; urgent: number; blocked: number; overdue: number; pendingValidation: number; unassigned: number };

class SupportError extends Error {}

/** Why a support call failed, in operator words. */
export function supportReason(status: number | null, error?: unknown): string {
  if (status === 404) return 'Le CRM de cette agence n’a pas encore l’API support : mettez-le à jour.';
  if (status === 429) return 'Le CRM limite les appels (30 par minute) : nouvel essai au prochain passage.';
  if (status != null) return `Le CRM a répondu ${status} : ${healthReason(String(status))}`;
  return `Le CRM ne répond pas : ${healthReason(error instanceof Error ? error.message : String(error ?? ''))}`;
}

function api(p: Platform, agency: Agency) {
  const state = readState(p.sealer, agency);
  if (!state) throw new SupportError('Cette agence n’a pas encore été créée sur les serveurs.');
  return instanceApi(p, state);
}

async function call(p: Platform, agency: Agency, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const send = api(p, agency);
  try {
    return await send(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { 'Content-Type': 'application/json' });
  } catch (err) {
    throw new SupportError(supportReason(null, err));
  }
}

// ---------- sync ----------

async function upsertSummary(sql: Sql, agencyId: string, row: RemoteSummary | RemoteTicket, now: Date): Promise<void> {
  const t = { ...row, attachments: Array.isArray(row.attachments) ? row.attachments.length : row.attachments };
  await sql`
    INSERT INTO support_tickets (agency_id, ticket_id, number, ref, title, preview, category, scope, priority, status, validation,
      requester_name, requester_role, assignee_name, client_name, comments, attachments, due_date, created_at, updated_at, completed_at, synced_at)
    VALUES (${agencyId}, ${t.id}, ${t.number}, ${t.ref}, ${t.title}, ${t.preview}, ${t.category}, ${t.scope}, ${t.priority}, ${t.status}, ${t.validation},
      ${t.requester?.name ?? null}, ${t.requester?.role ?? null}, ${t.assignee?.name ?? null}, ${t.client?.name ?? null}, ${t.comments}, ${t.attachments},
      ${t.dueDate}, ${t.createdAt}, ${t.updatedAt}, ${t.completedAt}, ${now})
    ON CONFLICT (agency_id, ticket_id) DO UPDATE SET
      number = excluded.number, ref = excluded.ref, title = excluded.title, preview = excluded.preview, category = excluded.category,
      scope = excluded.scope, priority = excluded.priority, status = excluded.status, validation = excluded.validation,
      requester_name = excluded.requester_name, requester_role = excluded.requester_role, assignee_name = excluded.assignee_name,
      client_name = excluded.client_name, comments = excluded.comments, attachments = excluded.attachments, due_date = excluded.due_date,
      created_at = excluded.created_at, updated_at = excluded.updated_at, completed_at = excluded.completed_at, synced_at = excluded.synced_at`;
  // Older CRM images do not send it: keep what opening the ticket taught us.
  if ('lastPlatformReplyAt' in t && t.lastPlatformReplyAt !== undefined) {
    await sql`UPDATE support_tickets SET last_platform_reply_at = ${t.lastPlatformReplyAt} WHERE agency_id = ${agencyId} AND ticket_id = ${t.id}`;
  }
}

/**
 * One agency: incremental pass (updatedSince = last serverTime), or a full pass that also drops
 * tickets deleted in the CRM. Records the error on support_sync instead of throwing, so one agency
 * never blocks the others.
 */
export async function syncAgencySupport(p: Platform, agency: Agency, now: Date, opts: { full?: boolean } = {}): Promise<{ ok: boolean; fetched: number; error?: string }> {
  const [sync] = await p.sql<{ cursor: Date | null; fullSyncedAt: Date | null }[]>`SELECT cursor, full_synced_at FROM support_sync WHERE agency_id = ${agency.id}`;
  const full = opts.full || !sync?.cursor || !sync.fullSyncedAt || now.getTime() - sync.fullSyncedAt.getTime() >= FULL_SYNC_EVERY_MS;
  const seen = new Set<string>();
  let cursor: string | null = null;
  let serverTime: string | null = null;
  let counts: SupportCounts | null = null;
  let fetched = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (!full && sync?.cursor) q.set('updatedSince', new Date(sync.cursor).toISOString());
      if (cursor) q.set('cursor', cursor);
      const r = await call(p, agency, 'GET', `/api/instance/support/tickets?${q}`);
      if (r.status !== 200 || !r.json?.ok || !Array.isArray(r.json.tickets)) throw new SupportError(supportReason(r.status));
      if (page === 0) {
        // the first page's clock and counters describe the instance at the start of the pass
        serverTime = r.json.serverTime ?? null;
        counts = r.json.counts ?? null;
      }
      for (const t of r.json.tickets as RemoteSummary[]) {
        if (!TICKET_ID.test(t.id)) continue;
        seen.add(t.id);
        await upsertSummary(p.sql, agency.id, t, now);
        fetched++;
      }
      cursor = r.json.nextCursor ?? null;
      if (!cursor) break;
    }
    if (full && !cursor) {
      // Everything was listed: whatever the cache still holds was deleted in the CRM.
      const ids = [...seen];
      await p.sql`DELETE FROM support_tickets WHERE agency_id = ${agency.id} AND NOT (ticket_id = ANY(${ids}::text[]))`;
    }
    await p.sql`
      INSERT INTO support_sync (agency_id, cursor, counts, synced_at, full_synced_at, error, error_at)
      VALUES (${agency.id}, ${serverTime ?? now.toISOString()}, ${counts ? p.sql.json(counts) : null}, ${now}, ${full ? now : null}, null, null)
      ON CONFLICT (agency_id) DO UPDATE SET cursor = excluded.cursor, counts = coalesce(excluded.counts, support_sync.counts), synced_at = excluded.synced_at,
        full_synced_at = coalesce(excluded.full_synced_at, support_sync.full_synced_at), error = null, error_at = null`;
    return { ok: true, fetched };
  } catch (err) {
    const message = err instanceof SupportError ? err.message : `Synchronisation impossible : ${String(err)}`;
    if (!(err instanceof SupportError)) log.error('support.sync_failed', { agency: agency.slug, ...errorFields(err) });
    await p.sql`
      INSERT INTO support_sync (agency_id, synced_at, error, error_at) VALUES (${agency.id}, ${now}, ${message}, ${now})
      ON CONFLICT (agency_id) DO UPDATE SET synced_at = excluded.synced_at, error = excluded.error, error_at = excluded.error_at`;
    return { ok: false, fetched, error: message };
  }
}

/** Agencies the inbox can read: live, with secrets, and not known to be offline. */
export function syncable(a: Agency): boolean {
  return LIVE.has(a.status) && Boolean(a.stateEnc) && a.healthOk !== false;
}

/** Scheduler pass: every agency due for a sync, in parallel; then the urgent-ticket alerts. */
export async function supportPass(p: Platform, now: Date): Promise<void> {
  const rows = await p.sql<{ agencyId: string; syncedAt: Date | null }[]>`SELECT agency_id, synced_at FROM support_sync`;
  const last = new Map(rows.map((r) => [r.agencyId, r.syncedAt]));
  const due = (await listAgencies(p.sql)).filter((a) => {
    if (!syncable(a)) return false;
    const at = last.get(a.id);
    return !at || now.getTime() - at.getTime() >= SYNC_EVERY_MS - 10_000;
  });
  await Promise.all(due.map((a) => syncAgencySupport(p, a, now)));
  for (const a of due) await urgentAlert(p, a);
  // Offline agencies are not called (30 s timeouts each); the inbox says why their tickets stopped moving.
  for (const a of (await listAgencies(p.sql)).filter((x) => LIVE.has(x.status) && x.stateEnc && x.healthOk === false)) {
    await p.sql`
      INSERT INTO support_sync (agency_id, error, error_at) VALUES (${a.id}, ${OFFLINE}, ${now})
      ON CONFLICT (agency_id) DO UPDATE SET error = excluded.error, error_at = coalesce(support_sync.error_at, excluded.error_at)
      WHERE support_sync.error IS DISTINCT FROM excluded.error`;
  }
}

const OFFLINE = 'L’agence est hors ligne : synchronisation en pause jusqu’à son retour.';

/** One alert per agency while it has open URGENT tickets: they are the ones nobody may miss. */
async function urgentAlert(p: Platform, a: Agency): Promise<void> {
  const urgent = await p.sql<{ ref: string; title: string }[]>`
    SELECT ref, title FROM support_tickets WHERE agency_id = ${a.id} AND priority = 'URGENT' AND status <> 'COMPLETED' AND validation <> 'REJECTED'
    ORDER BY updated_at DESC LIMIT 5`;
  if (urgent.length) {
    await openAlert(p.sql, p.infra.notify, {
      agencyId: a.id,
      agencyName: a.name,
      kind: 'support',
      key: 'support-urgent',
      message: `Ticket(s) urgent(s) ouvert(s) dans le CRM :\n${urgent.map((t) => `${t.ref} · ${t.title}`).join('\n')}`,
    });
  } else {
    await resolveAlert(p.sql, p.infra.notify, { agencyId: a.id, agencyName: a.name, key: 'support-urgent', message: 'Plus de ticket urgent ouvert' });
  }
}

// ---------- the inbox ----------

export const VIEWS = ['open', 'unread', 'unanswered', 'urgent', 'overdue', 'blocked', 'pending', 'done', 'all'] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<View, string> = {
  open: 'Ouverts',
  unread: 'Non lus',
  unanswered: 'Sans réponse',
  urgent: 'Urgents',
  overdue: 'En retard',
  blocked: 'Bloqués',
  pending: 'À valider',
  done: 'Terminés',
  all: 'Tous',
};
export const VIEW_HINTS: Record<View, string> = {
  open: 'Tout ce qui n’est pas terminé',
  unread: 'Modifiés depuis votre dernière lecture',
  unanswered: 'Ouverts, sans réponse du support plateforme',
  urgent: 'Priorité urgente, ouverts',
  overdue: 'Échéance dépassée',
  blocked: 'Statut bloqué',
  pending: 'Demandes en attente de validation par l’agence',
  done: 'Terminés',
  all: 'Tous les tickets',
};

export type InboxFilters = { view: View; agency: string | null; status: string | null; priority: string | null; category: string | null; q: string | null; page: number };

const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null => (v && (allowed as readonly string[]).includes(v) ? (v as T) : null);

export function parseFilters(q: Record<string, string | undefined>): InboxFilters {
  const page = Number(q.page);
  return {
    view: pick(q.view, VIEWS) ?? 'open',
    agency: q.agency && /^[a-z0-9-]{1,63}$/.test(q.agency) ? q.agency : null,
    status: pick(q.status, STATUSES),
    priority: pick(q.priority, PRIORITIES),
    category: pick(q.category, CATEGORIES),
    q: q.q?.trim().slice(0, 120) || null,
    page: Number.isInteger(page) && page > 0 && page < 1000 ? page : 1,
  };
}

/** Query string of a filter set, minus the defaults (links keep their filters). */
export function filterQuery(f: Partial<InboxFilters> & { t?: string | null }): string {
  const q = new URLSearchParams();
  if (f.view && f.view !== 'open') q.set('view', f.view);
  for (const k of ['agency', 'status', 'priority', 'category', 'q', 't'] as const) {
    const v = f[k];
    if (v) q.set(k, v);
  }
  if (f.page && f.page > 1) q.set('page', String(f.page));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export type InboxRow = {
  agencyId: string;
  agencySlug: string;
  agencyName: string;
  ticketId: string;
  ref: string;
  title: string;
  preview: string | null;
  category: string;
  priority: string;
  status: string;
  validation: string;
  requesterName: string | null;
  requesterRole: string | null;
  assigneeName: string | null;
  clientName: string | null;
  comments: number;
  attachments: number;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastPlatformReplyAt: Date | null;
  unread: boolean;
};

export const PAGE_SIZE = 50;

function viewWhere(sql: Sql, view: View, now: Date) {
  const open = sql`t.status <> 'COMPLETED' AND t.validation <> 'REJECTED'`;
  switch (view) {
    case 'open': return open;
    case 'unread': return sql`${open} AND (r.read_at IS NULL OR r.read_at < t.updated_at)`;
    case 'unanswered': return sql`${open} AND t.validation <> 'PENDING' AND t.last_platform_reply_at IS NULL`;
    case 'urgent': return sql`${open} AND t.priority = 'URGENT'`;
    case 'overdue': return sql`${open} AND t.due_date < ${now}`;
    case 'blocked': return sql`t.status = 'BLOCKED'`;
    case 'pending': return sql`t.validation = 'PENDING'`;
    case 'done': return sql`t.status = 'COMPLETED'`;
    case 'all': return sql`true`;
  }
}

export async function listInbox(sql: Sql, operatorId: string, f: InboxFilters, now: Date): Promise<{ rows: InboxRow[]; total: number }> {
  const where = sql`
    a.status <> 'deleted' AND ${viewWhere(sql, f.view, now)}
    ${f.agency ? sql`AND a.slug = ${f.agency}` : sql``}
    ${f.status ? sql`AND t.status = ${f.status}` : sql``}
    ${f.priority ? sql`AND t.priority = ${f.priority}` : sql``}
    ${f.category ? sql`AND t.category = ${f.category}` : sql``}
    ${f.q ? sql`AND (t.title ILIKE ${'%' + f.q.replace(/[\\%_]/g, '\\$&') + '%'} OR t.preview ILIKE ${'%' + f.q.replace(/[\\%_]/g, '\\$&') + '%'} OR t.ref ILIKE ${'%' + f.q.replace(/^#/, '').replace(/[\\%_]/g, '\\$&') + '%'} OR a.name ILIKE ${'%' + f.q.replace(/[\\%_]/g, '\\$&') + '%'})` : sql``}`;
  const from = sql`
    FROM support_tickets t
    JOIN agencies a ON a.id = t.agency_id
    LEFT JOIN support_reads r ON r.operator_id = ${operatorId} AND r.agency_id = t.agency_id AND r.ticket_id = t.ticket_id`;
  const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n ${from} WHERE ${where}`;
  const rows = await sql<InboxRow[]>`
    SELECT t.agency_id, a.slug AS agency_slug, a.name AS agency_name, t.ticket_id, t.ref, t.title, t.preview, t.category, t.priority, t.status,
      t.validation, t.requester_name, t.requester_role, t.assignee_name, t.client_name, t.comments, t.attachments, t.due_date, t.created_at,
      t.updated_at, t.last_platform_reply_at, (r.read_at IS NULL OR r.read_at < t.updated_at) AS unread
    ${from} WHERE ${where}
    ORDER BY (t.priority = 'URGENT' AND t.status <> 'COMPLETED') DESC, t.updated_at DESC, t.ticket_id
    LIMIT ${PAGE_SIZE} OFFSET ${(f.page - 1) * PAGE_SIZE}`;
  return { rows, total: n };
}

export type AgencySupport = { id: string; slug: string; name: string; open: number; urgent: number; syncedAt: Date | null; error: string | null; errorAt: Date | null };

/** Counts for the left column: one per view, and the agencies with their open tickets and sync state. */
export async function inboxCounts(sql: Sql, operatorId: string, now: Date): Promise<{ views: Record<View, number>; agencies: AgencySupport[] }> {
  const views = {} as Record<View, number>;
  const [row] = await sql<Record<View, number>[]>`
    SELECT
      count(*) FILTER (WHERE ${viewWhere(sql, 'open', now)})::int AS open,
      count(*) FILTER (WHERE ${viewWhere(sql, 'unread', now)})::int AS unread,
      count(*) FILTER (WHERE ${viewWhere(sql, 'unanswered', now)})::int AS unanswered,
      count(*) FILTER (WHERE ${viewWhere(sql, 'urgent', now)})::int AS urgent,
      count(*) FILTER (WHERE ${viewWhere(sql, 'overdue', now)})::int AS overdue,
      count(*) FILTER (WHERE ${viewWhere(sql, 'blocked', now)})::int AS blocked,
      count(*) FILTER (WHERE ${viewWhere(sql, 'pending', now)})::int AS pending,
      count(*) FILTER (WHERE ${viewWhere(sql, 'done', now)})::int AS done,
      count(*)::int AS all
    FROM support_tickets t
    JOIN agencies a ON a.id = t.agency_id AND a.status <> 'deleted'
    LEFT JOIN support_reads r ON r.operator_id = ${operatorId} AND r.agency_id = t.agency_id AND r.ticket_id = t.ticket_id`;
  for (const v of VIEWS) views[v] = row?.[v] ?? 0;
  const agencies = await sql<AgencySupport[]>`
    SELECT a.id, a.slug, a.name,
      count(t.ticket_id) FILTER (WHERE t.status <> 'COMPLETED' AND t.validation <> 'REJECTED')::int AS open,
      count(t.ticket_id) FILTER (WHERE t.priority = 'URGENT' AND t.status <> 'COMPLETED' AND t.validation <> 'REJECTED')::int AS urgent,
      s.synced_at, s.error, s.error_at
    FROM agencies a
    LEFT JOIN support_tickets t ON t.agency_id = a.id
    LEFT JOIN support_sync s ON s.agency_id = a.id
    WHERE a.status IN ('active', 'suspended')
    GROUP BY a.id, a.slug, a.name, s.synced_at, s.error, s.error_at
    ORDER BY count(t.ticket_id) FILTER (WHERE t.status <> 'COMPLETED' AND t.validation <> 'REJECTED') DESC, a.name`;
  return { views, agencies };
}

/** Per-agency counters for the fleet table and the agency page. */
export async function supportByAgency(sql: Sql): Promise<Map<string, { open: number; urgent: number; error: string | null }>> {
  const rows = await sql<{ agencyId: string; open: number; urgent: number; error: string | null }[]>`
    SELECT a.id AS agency_id,
      count(t.ticket_id) FILTER (WHERE t.status <> 'COMPLETED' AND t.validation <> 'REJECTED')::int AS open,
      count(t.ticket_id) FILTER (WHERE t.priority = 'URGENT' AND t.status <> 'COMPLETED' AND t.validation <> 'REJECTED')::int AS urgent,
      s.error
    FROM agencies a LEFT JOIN support_tickets t ON t.agency_id = a.id LEFT JOIN support_sync s ON s.agency_id = a.id
    GROUP BY a.id, s.error`;
  return new Map(rows.map((r) => [r.agencyId, { open: r.open, urgent: r.urgent, error: r.error }]));
}

/** Nav badge: open tickets this operator has not read since they last changed. */
export async function unreadCount(sql: Sql, operatorId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM support_tickets t
    JOIN agencies a ON a.id = t.agency_id AND a.status <> 'deleted'
    LEFT JOIN support_reads r ON r.operator_id = ${operatorId} AND r.agency_id = t.agency_id AND r.ticket_id = t.ticket_id
    WHERE t.status <> 'COMPLETED' AND t.validation <> 'REJECTED' AND (r.read_at IS NULL OR r.read_at < t.updated_at)`;
  return r?.n ?? 0;
}

// ---------- one ticket, live ----------

async function remember(sql: Sql, agencyId: string, t: RemoteTicket, now: Date): Promise<void> {
  await upsertSummary(sql, agencyId, t, now);
  const lastPlatform = t.thread.filter((i) => i.kind === 'comment' && i.author.platform).map((i) => i.at).sort().pop() ?? null;
  await sql`UPDATE support_tickets SET last_platform_reply_at = ${lastPlatform} WHERE agency_id = ${agencyId} AND ticket_id = ${t.id}`;
}

export async function markRead(sql: Sql, operatorId: string, agencyId: string, ticketId: string, at: Date): Promise<void> {
  await sql`
    INSERT INTO support_reads (operator_id, agency_id, ticket_id, read_at) VALUES (${operatorId}, ${agencyId}, ${ticketId}, ${at})
    ON CONFLICT (operator_id, agency_id, ticket_id) DO UPDATE SET read_at = excluded.read_at`;
}

export type TicketResult = { ok: true; ticket: RemoteTicket } | { ok: false; status: number | null; message: string };

/** Reads the ticket from the agency's CRM, refreshes the cache and marks it read for this operator. */
export async function fetchTicket(p: Platform, agency: Agency, ticketId: string, operatorId: string, now: Date): Promise<TicketResult> {
  if (!TICKET_ID.test(ticketId)) return { ok: false, status: 404, message: 'Ticket introuvable.' };
  try {
    const r = await call(p, agency, 'GET', `/api/instance/support/tickets/${ticketId}`);
    if (r.status === 404 && r.json?.error === 'ticket_not_found') {
      await p.sql`DELETE FROM support_tickets WHERE agency_id = ${agency.id} AND ticket_id = ${ticketId}`;
      return { ok: false, status: 404, message: 'Ce ticket a été supprimé dans le CRM de l’agence.' };
    }
    if (r.status !== 200 || !r.json?.ok) return { ok: false, status: r.status, message: supportReason(r.status) };
    const ticket = r.json.ticket as RemoteTicket;
    await remember(p.sql, agency.id, ticket, now);
    await markRead(p.sql, operatorId, agency.id, ticketId, new Date(Math.max(now.getTime(), Date.parse(ticket.updatedAt) || 0)));
    return { ok: true, ticket };
  } catch (err) {
    return unexpected('support.fetch_failed', agency, err);
  }
}

/** A failure of the Console itself (not the CRM): logged in full, told in plain words. */
function unexpected(event: string, agency: Agency, err: unknown): { ok: false; status: null; message: string } {
  if (err instanceof SupportError) return { ok: false, status: null, message: err.message };
  log.error(event, { agency: agency.slug, ...errorFields(err) });
  return { ok: false, status: null, message: 'Erreur interne de la Console : voir son journal. Le CRM de l’agence n’est pas en cause.' };
}

export type SupportAction =
  | { action: 'comment'; content: string }
  | { action: 'status'; status: TicketStatus; comment?: string }
  | { action: 'priority'; priority: TicketPriority };

export const MAX_REPLY = 10_000;

/** The form a teammate submitted, checked before anything is sent to the CRM. */
export function parseActionForm(body: Record<string, unknown>): { ok: true; value: SupportAction } | { ok: false; message: string } {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const content = s('content');
  if (content.length > MAX_REPLY) return { ok: false, message: `La réponse dépasse ${MAX_REPLY.toLocaleString('fr-FR')} caractères.` };
  switch (s('action')) {
    case 'comment': {
      const status = pick(s('status') || undefined, STATUSES);
      if (!content && !status) return { ok: false, message: 'Écrivez une réponse avant d’envoyer.' };
      return { ok: true, value: status ? { action: 'status', status, comment: content || undefined } : { action: 'comment', content } };
    }
    case 'status': {
      const status = pick(s('status') || undefined, STATUSES);
      return status ? { ok: true, value: { action: 'status', status, comment: content || undefined } } : { ok: false, message: 'Choisissez un statut.' };
    }
    case 'priority': {
      const priority = pick(s('priority') || undefined, PRIORITIES);
      return priority ? { ok: true, value: { action: 'priority', priority } } : { ok: false, message: 'Choisissez une priorité.' };
    }
    default:
      return { ok: false, message: 'Action inconnue.' };
  }
}

/** Sends the action to the agency's CRM, signed with the operator's name. Refusals come back as the CRM worded them. */
export async function actOnTicket(p: Platform, agency: Agency, ticketId: string, action: SupportAction, operatorName: string, now: Date): Promise<TicketResult> {
  if (!TICKET_ID.test(ticketId)) return { ok: false, status: 404, message: 'Ticket introuvable.' };
  try {
    const r = await call(p, agency, 'POST', `/api/instance/support/tickets/${ticketId}`, { ...action, operator: operatorName });
    if (r.status === 422) {
      const msg = r.json?.message ?? Object.values((r.json?.errors ?? {}) as Record<string, string>).join(' · ');
      return { ok: false, status: 422, message: msg ? `Le CRM refuse : ${msg}` : 'Le CRM refuse ce changement.' };
    }
    if (r.status === 404) return { ok: false, status: 404, message: r.json?.error === 'ticket_not_found' ? 'Ce ticket a été supprimé dans le CRM de l’agence.' : supportReason(404) };
    if (r.status !== 200 || !r.json?.ok) return { ok: false, status: r.status, message: supportReason(r.status) };
    const ticket = r.json.ticket as RemoteTicket;
    await remember(p.sql, agency.id, ticket, now);
    return { ok: true, ticket };
  } catch (err) {
    return unexpected('support.action_failed', agency, err);
  }
}

// ---------- canned replies ----------

export type Macro = { id: string; title: string; body: string; createdAt: Date; createdByName: string | null };

export async function listMacros(sql: Sql): Promise<Macro[]> {
  return sql<Macro[]>`
    SELECT m.id, m.title, m.body, m.created_at, o.name AS created_by_name
    FROM support_macros m LEFT JOIN operators o ON o.id = m.created_by ORDER BY lower(m.title)`;
}

export function macroProblem(title: string, body: string): string | null {
  if (!title || title.length > 80) return 'Donnez un titre (80 caractères au plus).';
  if (!body || body.length > MAX_REPLY) return 'Écrivez le texte de la réponse.';
  return null;
}

export async function createMacro(sql: Sql, input: { title: string; body: string; createdBy: string }): Promise<string> {
  const [r] = await sql<{ id: string }[]>`INSERT INTO support_macros (title, body, created_by) VALUES (${input.title}, ${input.body}, ${input.createdBy}) RETURNING id`;
  return r!.id;
}

export async function deleteMacro(sql: Sql, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const rows = await sql`DELETE FROM support_macros WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
