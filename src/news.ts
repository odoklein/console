// « Nouveautés »: release notes and announcements for the agencies' teams.
//
//   release       a CRM image tag plus its notes. Drafted from the commits between two tags
//                 (GitHub compare), edited here, then published. A published release reaches an
//                 agency when it runs that tag (target 'tag', the default) — at publish time for
//                 those already on it, right after its upgrade for the others — or every agency at
//                 once (target 'all').
//   announcement  standalone news (feature, maintenance, info, billing) for all agencies, some
//                 packs or some agencies. Published on creation.
//   delivery      one (agency, item) pair. The delivery pass sends it with the CRM's signed API
//                 (PUT /api/instance/changelog, DELETE …/:externalId; contract in the CRM repo,
//                 docs/CONSOLE_CHANGELOG.md), retries with backoff, and the stats pass reads back
//                 how many people saw it.

import { listAgencies, readState, type Agency } from './agencies.ts';
import type { Sql } from './db.ts';
import { healthReason } from './health-reason.ts';
import type { GitCommit } from './infra/types.ts';
import { instanceApi } from './jobs/ops.ts';
import { errorFields, log } from './log.ts';
import type { Platform } from './platform.ts';

export const NOTE_TYPES = ['new', 'improved', 'fixed'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const NOTE_TYPE_LABELS: Record<NoteType, string> = { new: 'Nouveau', improved: 'Amélioré', fixed: 'Corrigé' };
export type Note = { type: NoteType; title: string; body: string | null; module: string | null };

export const CATEGORIES = ['feature', 'maintenance', 'info', 'billing'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = { feature: 'Nouveauté', maintenance: 'Maintenance', info: 'Information', billing: 'Facturation' };

export type Audience = 'managers' | 'everyone';
export const AUDIENCE_LABELS: Record<Audience, string> = { managers: 'Managers', everyone: 'Toute l’équipe (hors clients)' };

export const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** Agencies that receive news: running, or suspended (they still read billing notices). */
const RECEIVES = new Set(['active', 'suspended']);

// ---------- drafting notes from commits ----------

const SKIP_TYPES = new Set(['chore', 'docs', 'test', 'tests', 'ci', 'build', 'style', 'revert', 'wip']);
const NEW_VERBS = /^(add|adds|added|introduce|new|create|connect|launch|ship|enable|support|allow|bring)\b/i;
const FIX_VERBS = /^(fix|fixes|fixed|correct|repair|resolve|prevent|avoid|stop|handle)\b/i;

/** First paragraph of the commit body, without trailers (Co-Authored-By, Claude-Session…). */
export function commitBody(message: string): string | null {
  const [, ...rest] = message.split('\n');
  const body = rest.join('\n').trim();
  if (!body) return null;
  const first = body.split(/\n\s*\n/)[0]!
    .split('\n')
    .filter((l) => !/^[A-Za-z-]+: /.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!first) return null;
  return first.length > 280 ? `${first.slice(0, 277).trimEnd()}…` : first;
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * One draft note per meaningful commit. Conventional prefixes decide the type (feat → Nouveau,
 * fix → Corrigé, the rest → Amélioré); chores, docs, tests, merges and reverts are left out.
 * Plain subjects are typed by their verb. Everything stays editable before publishing.
 */
export function draftNotes(commits: GitCommit[]): { notes: Note[]; skipped: number } {
  const notes: Note[] = [];
  let skipped = 0;
  for (const c of commits) {
    const subject = c.message.split('\n')[0]!.trim();
    if (!subject || /^merge\b/i.test(subject)) {
      skipped++;
      continue;
    }
    const conv = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    let type: NoteType;
    let title: string;
    let module: string | null = null;
    if (conv) {
      const kind = conv[1]!.toLowerCase();
      if (SKIP_TYPES.has(kind)) {
        skipped++;
        continue;
      }
      type = kind === 'feat' ? 'new' : kind === 'fix' ? 'fixed' : 'improved';
      module = conv[2] ? capitalize(conv[2].replace(/[-_]/g, ' ')) : null;
      title = conv[4]!;
    } else {
      title = subject;
      type = NEW_VERBS.test(subject) ? 'new' : FIX_VERBS.test(subject) ? 'fixed' : 'improved';
    }
    title = capitalize(title.replace(/\s*\(#\d+\)\s*$/, '').replace(/\.$/, '').trim()).slice(0, 140);
    // The commit body is written for developers: the note starts with the subject only, and the
    // commits stay listed under the editor for reference.
    notes.push({ type, title, body: null, module });
  }
  return { notes, skipped };
}

/** Validates notes coming from the editor form; returns the clean list or the first problem. */
export function cleanNotes(raw: unknown): { ok: true; notes: Note[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'Notes illisibles.' };
  if (raw.length > 80) return { ok: false, error: '80 notes au maximum.' };
  const notes: Note[] = [];
  for (const [i, n] of raw.entries()) {
    const type = (n as Note)?.type;
    const title = String((n as Note)?.title ?? '').trim();
    const body = String((n as Note)?.body ?? '').trim();
    const module = String((n as Note)?.module ?? '').trim();
    if (!title && !body) continue;
    if (!NOTE_TYPES.includes(type)) return { ok: false, error: `Note ${i + 1} : type inconnu.` };
    if (!title) return { ok: false, error: `Note ${i + 1} : le titre manque.` };
    if (title.length > 140) return { ok: false, error: `Note ${i + 1} : titre trop long (140 caractères au plus).` };
    if (body.length > 1000) return { ok: false, error: `Note ${i + 1} : détail trop long (1000 caractères au plus).` };
    if (module.length > 60) return { ok: false, error: `Note ${i + 1} : module trop long (60 caractères au plus).` };
    notes.push({ type, title, body: body || null, module: module || null });
  }
  return { ok: true, notes };
}

// ---------- releases ----------

export type ReleaseStatus = 'draft' | 'published' | 'archived';
export type Release = {
  id: string;
  tag: string;
  title: string;
  summary: string;
  audience: Audience;
  target: 'tag' | 'all';
  channel: 'stable' | 'beta';
  status: ReleaseStatus;
  notes: Note[];
  fromTag: string | null;
  commits: GitCommit[];
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
};

export async function listReleases(sql: Sql): Promise<Release[]> {
  return sql<Release[]>`SELECT * FROM releases WHERE status <> 'archived' ORDER BY coalesce(published_at, created_at) DESC`;
}

export async function getRelease(sql: Sql, id: string): Promise<Release | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [r] = await sql<Release[]>`SELECT * FROM releases WHERE id = ${id}`;
  return r ?? null;
}

/** The newest published release before this one: the default « depuis » of a new draft. */
export async function previousTag(sql: Sql): Promise<string | null> {
  const [r] = await sql<{ tag: string }[]>`SELECT tag FROM releases WHERE status = 'published' ORDER BY published_at DESC LIMIT 1`;
  return r?.tag ?? null;
}

export type CreateReleaseResult = { ok: true; id: string; drafted: number; skipped: number; githubError?: string } | { ok: false; error: string };

export async function createRelease(p: Platform, input: { tag: string; fromTag: string; operatorId: string; now: Date }): Promise<CreateReleaseResult> {
  const tag = input.tag.trim();
  const fromTag = input.fromTag.trim();
  if (!TAG.test(tag)) return { ok: false, error: 'Version : lettres, chiffres, « . », « - » ou « _ » (ex. 9be5e12).' };
  if (fromTag && !TAG.test(fromTag)) return { ok: false, error: 'Version de départ invalide.' };
  const [exists] = await p.sql<{ id: string }[]>`SELECT id FROM releases WHERE tag = ${tag}`;
  if (exists) return { ok: false, error: `La version ${tag} a déjà ses notes.` };

  let commits: GitCommit[] = [];
  let githubError: string | undefined;
  if (fromTag && p.infra.github) {
    try {
      commits = await p.infra.github.compare(fromTag, tag);
    } catch (err) {
      githubError = err instanceof Error ? err.message : String(err);
      log.warn('news.github_failed', { tag, fromTag, error: githubError });
    }
  }
  const { notes, skipped } = draftNotes(commits);
  const title = `Mise à jour du ${new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' }).format(input.now)}`;
  const [row] = await p.sql<{ id: string }[]>`
    INSERT INTO releases (tag, title, notes, from_tag, commits, created_by)
    VALUES (${tag}, ${title}, ${p.sql.json(notes as never)}, ${fromTag || null}, ${p.sql.json(commits as never)}, ${input.operatorId})
    RETURNING id`;
  return { ok: true, id: row!.id, drafted: notes.length, skipped, githubError };
}

export async function saveRelease(sql: Sql, id: string, input: { title: string; summary: string; audience: Audience; target: 'tag' | 'all'; notes: Note[] }): Promise<void> {
  await sql`
    UPDATE releases SET title = ${input.title}, summary = ${input.summary}, audience = ${input.audience}, target = ${input.target},
      notes = ${sql.json(input.notes as never)}, updated_at = now()
    WHERE id = ${id}`;
}

export function releaseProblem(r: Pick<Release, 'title' | 'summary' | 'notes'>): string | null {
  if (!r.title.trim()) return 'Donnez un titre à cette mise à jour.';
  if (r.title.length > 140) return 'Titre trop long (140 caractères au plus).';
  if (r.summary.length > 4000) return 'Résumé trop long (4000 caractères au plus).';
  if (!r.notes.length && !r.summary.trim()) return 'Ajoutez au moins une note ou un résumé avant de publier.';
  return null;
}

/** Agencies a release goes to now: those running its tag, or all of them. */
export function releaseTargets(r: Pick<Release, 'tag' | 'target'>, agencies: Agency[]): Agency[] {
  return agencies.filter((a) => RECEIVES.has(a.status) && (r.target === 'all' || a.imageTag === r.tag));
}

export async function publishRelease(sql: Sql, id: string): Promise<{ ok: true; queued: number } | { ok: false; error: string }> {
  const r = await getRelease(sql, id);
  if (!r) return { ok: false, error: 'Version introuvable.' };
  const problem = releaseProblem(r);
  if (problem) return { ok: false, error: problem };
  await sql`UPDATE releases SET status = 'published', published_at = coalesce(published_at, now()), updated_at = now() WHERE id = ${id}`;
  // Already delivered somewhere (an edit after publishing): send the new text again.
  await sql`UPDATE deliveries SET status = 'pending', action = 'put', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
            WHERE item_kind = 'release' AND item_id = ${id} AND status <> 'retracted'`;
  const queued = await queue(sql, 'release', id, releaseTargets(r, await listAgencies(sql)).map((a) => a.id));
  return { ok: true, queued };
}

export async function retract(sql: Sql, kind: 'release' | 'announcement', id: string): Promise<void> {
  if (kind === 'release') await sql`UPDATE releases SET status = 'draft', updated_at = now() WHERE id = ${id}`;
  else await sql`UPDATE announcements SET status = 'retracted', retracted_at = now() WHERE id = ${id}`;
  // Only what an agency may hold needs a DELETE; never-delivered ones just stop.
  await sql`UPDATE deliveries SET status = 'retracted', updated_at = now() WHERE item_kind = ${kind} AND item_id = ${id} AND delivered_at IS NULL AND status <> 'retracted'`;
  await sql`UPDATE deliveries SET status = 'pending', action = 'delete', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
            WHERE item_kind = ${kind} AND item_id = ${id} AND status <> 'retracted'`;
}

/** After an upgrade: the release of the tag it now runs, and anything an older image could not take. */
export async function onAgencyVersion(sql: Sql, agencyId: string, tag: string): Promise<void> {
  await sql`UPDATE deliveries SET status = 'pending', next_attempt_at = now(), updated_at = now() WHERE agency_id = ${agencyId} AND status = 'unsupported'`;
  const [r] = await sql<{ id: string }[]>`SELECT id FROM releases WHERE tag = ${tag} AND status = 'published'`;
  if (r) await queue(sql, 'release', r.id, [agencyId]);
}

// ---------- announcements ----------

export type AnnouncementTarget = { all: true } | { packs: string[] } | { agencyIds: string[] };
export type Announcement = {
  id: string;
  kind: Category;
  title: string;
  body: string;
  severity: 'info' | 'warning';
  audience: Audience;
  startsAt: Date | null;
  endsAt: Date | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  target: AnnouncementTarget;
  status: 'published' | 'retracted';
  createdAt: Date;
  publishedAt: Date;
  retractedAt: Date | null;
};

export type AnnouncementInput = Omit<Announcement, 'id' | 'status' | 'createdAt' | 'publishedAt' | 'retractedAt'>;

export function announcementTargets(target: AnnouncementTarget, agencies: Agency[]): Agency[] {
  const live = agencies.filter((a) => RECEIVES.has(a.status));
  if ('all' in target) return live;
  if ('packs' in target) return live.filter((a) => target.packs.includes(a.config.extra?.pack ?? ''));
  return live.filter((a) => target.agencyIds.includes(a.id));
}

export function announcementProblem(a: AnnouncementInput): string | null {
  if (!a.title.trim()) return 'Le titre manque.';
  if (a.title.length > 140) return 'Titre trop long (140 caractères au plus).';
  if (a.body.length > 4000) return 'Texte trop long (4000 caractères au plus).';
  if (!CATEGORIES.includes(a.kind)) return 'Type d’annonce inconnu.';
  if (a.startsAt && a.endsAt && a.endsAt <= a.startsAt) return 'La fin doit suivre le début.';
  if (a.endsAt && a.endsAt.getTime() <= Date.now()) return 'Cette annonce serait déjà terminée : vérifiez la date de fin.';
  if ((a.ctaLabel && !a.ctaUrl) || (!a.ctaLabel && a.ctaUrl)) return 'Le bouton a besoin d’un libellé et d’un lien.';
  if (a.ctaLabel && a.ctaLabel.length > 40) return 'Libellé du bouton trop long (40 caractères au plus).';
  if (a.ctaUrl && !(/^https:\/\/\S+$/.test(a.ctaUrl) || (a.ctaUrl.startsWith('/') && !a.ctaUrl.startsWith('//')))) return 'Lien du bouton : https://… ou un chemin du CRM (/manager/…).';
  if ('packs' in a.target && !a.target.packs.length) return 'Choisissez au moins une offre.';
  if ('agencyIds' in a.target && !a.target.agencyIds.length) return 'Choisissez au moins une agence.';
  return null;
}

export async function createAnnouncement(sql: Sql, a: AnnouncementInput, operatorId: string): Promise<{ id: string; queued: number }> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO announcements (kind, title, body, severity, audience, starts_at, ends_at, cta_label, cta_url, target, created_by)
    VALUES (${a.kind}, ${a.title}, ${a.body}, ${a.severity}, ${a.audience}, ${a.startsAt}, ${a.endsAt}, ${a.ctaLabel}, ${a.ctaUrl},
            ${sql.json(a.target as never)}, ${operatorId})
    RETURNING id`;
  const queued = await queue(sql, 'announcement', row!.id, announcementTargets(a.target, await listAgencies(sql)).map((x) => x.id));
  return { id: row!.id, queued };
}

export async function listAnnouncements(sql: Sql): Promise<Announcement[]> {
  return sql<Announcement[]>`SELECT * FROM announcements ORDER BY published_at DESC LIMIT 100`;
}

// ---------- deliveries ----------

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'unsupported' | 'retracted';
export type Delivery = {
  id: string;
  agencyId: string;
  itemKind: 'release' | 'announcement';
  itemId: string;
  status: DeliveryStatus;
  action: 'put' | 'delete';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  seenUsers: number | null;
  totalUsers: number | null;
  seenCheckedAt: Date | null;
};

async function queue(sql: Sql, kind: 'release' | 'announcement', itemId: string, agencyIds: string[]): Promise<number> {
  let n = 0;
  for (const agencyId of agencyIds) {
    const r = await sql`
      INSERT INTO deliveries (agency_id, item_kind, item_id) VALUES (${agencyId}, ${kind}, ${itemId})
      ON CONFLICT (agency_id, item_kind, item_id) DO UPDATE SET status = 'pending', action = 'put', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE deliveries.status IN ('retracted', 'failed', 'unsupported')`;
    n += r.count;
  }
  return n;
}

export async function deliveriesOf(sql: Sql, kind: 'release' | 'announcement', itemId: string): Promise<(Delivery & { agencyName: string; agencySlug: string; agencyTag: string | null })[]> {
  return sql`
    SELECT d.*, a.name AS agency_name, a.slug AS agency_slug, a.image_tag AS agency_tag
    FROM deliveries d JOIN agencies a ON a.id = d.agency_id
    WHERE d.item_kind = ${kind} AND d.item_id = ${itemId}
    ORDER BY a.name`;
}

export type Reach = { agencies: number; delivered: number; pending: number; failed: number; unsupported: number; seen: number; audience: number };

/** Delivery and reading figures per item, for the lists. */
export async function reachByItem(sql: Sql, kind: 'release' | 'announcement'): Promise<Map<string, Reach>> {
  const rows = await sql<{ itemId: string; status: DeliveryStatus; action: string; n: number; seen: number; audience: number }[]>`
    SELECT item_id, status, action, count(*)::int AS n, coalesce(sum(seen_users), 0)::int AS seen, coalesce(sum(total_users), 0)::int AS audience
    FROM deliveries WHERE item_kind = ${kind} GROUP BY item_id, status, action`;
  const out = new Map<string, Reach>();
  for (const r of rows) {
    const m = out.get(r.itemId) ?? { agencies: 0, delivered: 0, pending: 0, failed: 0, unsupported: 0, seen: 0, audience: 0 };
    if (r.status !== 'retracted') m.agencies += r.n;
    if (r.status === 'delivered') {
      m.delivered += r.n;
      m.seen += r.seen;
      m.audience += r.audience;
    }
    if (r.status === 'pending') m.pending += r.n;
    if (r.status === 'failed') m.failed += r.n;
    if (r.status === 'unsupported') m.unsupported += r.n;
    out.set(r.itemId, m);
  }
  return out;
}

export function externalId(kind: 'release' | 'announcement', item: { id: string; tag?: string }): string {
  return kind === 'release' ? `release:${item.tag}` : `announcement:${item.id}`;
}

export function releasePayload(r: Release) {
  return {
    externalId: externalId('release', r),
    kind: 'release',
    title: r.title,
    summary: r.summary || null,
    version: r.tag,
    items: r.notes,
    audience: r.audience,
    publishedAt: (r.publishedAt ?? new Date()).toISOString(),
  };
}

export function announcementPayload(a: Announcement) {
  return {
    externalId: externalId('announcement', a),
    kind: 'announcement',
    title: a.title,
    summary: a.body || null,
    category: a.kind,
    severity: a.severity,
    audience: a.audience,
    cta: a.ctaLabel && a.ctaUrl ? { label: a.ctaLabel, url: a.ctaUrl } : null,
    startsAt: a.startsAt?.toISOString() ?? null,
    endsAt: a.endsAt?.toISOString() ?? null,
    publishedAt: a.publishedAt.toISOString(),
  };
}

/** Minutes before the next attempt, by attempt number. A rejected payload waits longest. */
const BACKOFF_MIN = [1, 5, 15, 60, 360, 1440];
const backoff = (attempts: number) => BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1]! * 60_000;

/** Operator words for a failed call. */
export function deliveryReason(status: number | null, json?: any, error?: unknown): string {
  if (status === 401) return 'Signature refusée : le secret de l’agence ne correspond plus.';
  if (status === 503) return 'L’API de l’agence n’est pas configurée (INSTANCE_ADMIN_SECRET absent).';
  if (status === 422) {
    const first = Array.isArray(json?.errors) ? json.errors[0] : null;
    return `Contenu refusé par le CRM${first ? ` (${first.path} : ${first.message})` : ''}.`;
  }
  if (status === 429) return 'Le CRM limite les appels : nouvel essai au prochain passage.';
  if (status != null) return `Le CRM a répondu ${status} : ${healthReason(String(status))}`;
  return `Le CRM ne répond pas : ${healthReason(error instanceof Error ? error.message : String(error ?? ''))}`;
}

const DUE_BATCH = 25;

/** Sends what is due. One failing agency never blocks the others. Returns the deliveries tried. */
export async function deliveryPass(p: Platform, now: Date): Promise<number> {
  const due = await p.sql<Delivery[]>`
    SELECT * FROM deliveries WHERE status IN ('pending', 'failed') AND next_attempt_at <= ${now}
    ORDER BY next_attempt_at LIMIT ${DUE_BATCH}`;
  if (!due.length) return 0;
  const agencies = new Map((await listAgencies(p.sql)).map((a) => [a.id, a]));
  for (const d of due) {
    const agency = agencies.get(d.agencyId);
    try {
      await deliver(p, d, agency, now);
    } catch (err) {
      log.error('news.delivery_crashed', { deliveryId: d.id, ...errorFields(err) });
    }
  }
  return due.length;
}

async function fail(sql: Sql, d: Delivery, reason: string, now: Date, minDelayMs = 0): Promise<void> {
  const attempts = d.attempts + 1;
  await sql`UPDATE deliveries SET status = 'failed', attempts = ${attempts}, last_error = ${reason},
            next_attempt_at = ${new Date(now.getTime() + Math.max(backoff(attempts), minDelayMs))}, updated_at = now() WHERE id = ${d.id}`;
}

async function deliver(p: Platform, d: Delivery, agency: Agency | undefined, now: Date): Promise<void> {
  const { sql } = p;
  if (!agency || agency.status === 'deleted' || agency.status === 'deleting') {
    await sql`UPDATE deliveries SET status = 'retracted', updated_at = now() WHERE id = ${d.id}`;
    return;
  }
  if (!RECEIVES.has(agency.status)) return fail(sql, d, 'Agence pas encore en service.', now);
  const state = readState(p.sealer, agency);
  if (!state) return fail(sql, d, 'Cette agence n’a pas encore été créée sur les serveurs.', now);
  const send = instanceApi(p, state);

  let path = '/api/instance/changelog';
  let method = 'PUT';
  let body: string | undefined;
  if (d.action === 'delete') {
    const id = d.itemKind === 'release'
      ? (await sql<{ tag: string }[]>`SELECT tag FROM releases WHERE id = ${d.itemId}`)[0]?.tag
      : d.itemId;
    if (!id) {
      await sql`UPDATE deliveries SET status = 'retracted', updated_at = now() WHERE id = ${d.id}`;
      return;
    }
    method = 'DELETE';
    path = `/api/instance/changelog/${encodeURIComponent(externalId(d.itemKind, { id, tag: id }))}`;
  } else if (d.itemKind === 'release') {
    const [r] = await sql<Release[]>`SELECT * FROM releases WHERE id = ${d.itemId} AND status = 'published'`;
    if (!r) {
      await sql`UPDATE deliveries SET status = 'retracted', updated_at = now() WHERE id = ${d.id}`;
      return;
    }
    body = JSON.stringify(releasePayload(r));
  } else {
    const [a] = await sql<Announcement[]>`SELECT * FROM announcements WHERE id = ${d.itemId} AND status = 'published'`;
    if (!a) {
      await sql`UPDATE deliveries SET status = 'retracted', updated_at = now() WHERE id = ${d.id}`;
      return;
    }
    body = JSON.stringify(announcementPayload(a));
  }

  let res: { status: number; json: any };
  try {
    res = await send(method, path, body, body ? { 'Content-Type': 'application/json' } : {});
  } catch (err) {
    return fail(sql, d, deliveryReason(null, undefined, err), now);
  }
  if (res.status >= 200 && res.status < 300) {
    if (d.action === 'delete') await sql`UPDATE deliveries SET status = 'retracted', attempts = ${d.attempts + 1}, last_error = NULL, updated_at = now() WHERE id = ${d.id}`;
    else await sql`UPDATE deliveries SET status = 'delivered', attempts = ${d.attempts + 1}, last_error = NULL, delivered_at = ${now}, updated_at = now() WHERE id = ${d.id}`;
    return;
  }
  if (res.status === 404) {
    // An image older than the Nouveautés API: nothing to remove, nothing to send until it is upgraded.
    if (d.action === 'delete') await sql`UPDATE deliveries SET status = 'retracted', updated_at = now() WHERE id = ${d.id}`;
    else await sql`UPDATE deliveries SET status = 'unsupported', attempts = ${d.attempts + 1}, last_error = ${'Version du CRM trop ancienne : envoi automatique après sa prochaine mise à jour.'}, updated_at = now() WHERE id = ${d.id}`;
    return;
  }
  return fail(sql, d, deliveryReason(res.status, res.json), now, res.status === 422 ? 6 * 3_600_000 : 0);
}

/** Retry now, from the delivery page. */
export async function retryDelivery(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE deliveries SET status = 'pending', next_attempt_at = now(), updated_at = now() WHERE id = ${id} AND status IN ('failed', 'unsupported')`;
}

export const STATS_EVERY_MS = 15 * 60_000;

/** How many people saw each delivered item, read back from the agencies holding one. */
export async function statsPass(p: Platform, now: Date): Promise<void> {
  const rows = await p.sql<{ agencyId: string }[]>`
    SELECT DISTINCT agency_id FROM deliveries
    WHERE status = 'delivered' AND (seen_checked_at IS NULL OR seen_checked_at < ${new Date(now.getTime() - STATS_EVERY_MS)})`;
  if (!rows.length) return;
  const agencies = new Map((await listAgencies(p.sql)).map((a) => [a.id, a]));
  for (const { agencyId } of rows) {
    const agency = agencies.get(agencyId);
    const state = agency ? readState(p.sealer, agency) : null;
    if (!agency || !state || !RECEIVES.has(agency.status)) continue;
    try {
      const res = await instanceApi(p, state)('GET', '/api/instance/changelog');
      if (res.status !== 200 || !Array.isArray(res.json?.entries)) continue;
      const byExternal = new Map<string, { seen: number; audienceSize: number }>(
        res.json.entries.map((e: { externalId: string; seen: number; audienceSize: number }) => [e.externalId, e]),
      );
      const held = await p.sql<{ id: string; itemKind: 'release' | 'announcement'; itemId: string; tag: string | null }[]>`
        SELECT d.id, d.item_kind, d.item_id, r.tag FROM deliveries d LEFT JOIN releases r ON d.item_kind = 'release' AND r.id = d.item_id
        WHERE d.agency_id = ${agencyId} AND d.status = 'delivered'`;
      for (const h of held) {
        const e = byExternal.get(externalId(h.itemKind, { id: h.itemId, tag: h.tag ?? undefined }));
        await p.sql`UPDATE deliveries SET seen_users = ${e?.seen ?? null}, total_users = ${e?.audienceSize ?? null}, seen_checked_at = ${now} WHERE id = ${h.id}`;
      }
    } catch (err) {
      log.warn('news.stats_failed', { agencyId, ...errorFields(err) });
    }
  }
}
