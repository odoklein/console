// Operators (our team) and their sessions. Email + password (scrypt); 5 failures lock the account
// for 15 minutes. Accounts are created by invitation (setup link), never with a password chosen by
// someone else.

import { hashPassword, newToken, tokenHash, verifyPassword } from './crypto.ts';
import type { Sql } from './db.ts';
import { isRole, type Role } from './roles.ts';

export type Operator = {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  role: Role;
  disabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
};

export type Session = { tokenHash: string; operatorId: string; verified: boolean; expiresAt: Date };

export const SESSION_TTL_MS = 12 * 3_600_000;
const SETUP_TTL_MS = 72 * 3_600_000;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 20;
const FAIL_WINDOW = '15 minutes';

export async function createOperator(sql: Sql, email: string, name: string, role: Role = 'operator'): Promise<{ operator: Operator; setupToken: string }> {
  const setupToken = newToken();
  const [operator] = await sql<Operator[]>`
    INSERT INTO operators (email, name, role, setup_token_hash, setup_expires_at)
    VALUES (${email.trim().toLowerCase()}, ${name.trim()}, ${role}, ${tokenHash(setupToken)}, ${new Date(Date.now() + SETUP_TTL_MS)})
    RETURNING *`;
  return { operator: operator!, setupToken };
}

/** New setup link for an existing operator (lost password): the password is reset. */
export async function resetOperator(sql: Sql, id: string): Promise<string> {
  const setupToken = newToken();
  await sql`
    UPDATE operators SET password_hash = NULL, totp_secret_enc = NULL, totp_enabled = false,
      setup_token_hash = ${tokenHash(setupToken)}, setup_expires_at = ${new Date(Date.now() + SETUP_TTL_MS)}
    WHERE id = ${id}`;
  await sql`DELETE FROM operator_sessions WHERE operator_id = ${id}`;
  return setupToken;
}

export async function operatorBySetupToken(sql: Sql, token: string): Promise<Operator | null> {
  const [op] = await sql<Operator[]>`
    SELECT * FROM operators WHERE setup_token_hash = ${tokenHash(token)} AND setup_expires_at > now() AND NOT disabled`;
  return op ?? null;
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return 'Au moins 12 caractères.';
  if (pw.length > 200) return 'Trop long.';
  if (new Set(pw).size < 6) return 'Trop répétitif.';
  return null;
}

export async function completeSetup(sql: Sql, operatorId: string, password: string): Promise<void> {
  await sql`
    UPDATE operators SET password_hash = ${await hashPassword(password)}, setup_token_hash = NULL, setup_expires_at = NULL
    WHERE id = ${operatorId}`;
}

export type LoginResult = { ok: true; operator: Operator } | { ok: false; reason: 'invalid' | 'throttled' };

export async function checkPassword(sql: Sql, email: string, password: string, ip: string | null): Promise<LoginResult> {
  const e = email.trim().toLowerCase();
  const [fails] = await sql<{ byEmail: number; byIp: number }[]>`
    SELECT count(*) FILTER (WHERE email = ${e})::int AS by_email, count(*) FILTER (WHERE ip = ${ip})::int AS by_ip
    FROM login_attempts WHERE NOT ok AND at > now() - ${FAIL_WINDOW}::interval`;
  if ((fails?.byEmail ?? 0) >= MAX_FAILS_PER_EMAIL || (ip && (fails?.byIp ?? 0) >= MAX_FAILS_PER_IP)) return { ok: false, reason: 'throttled' };

  const [op] = await sql<Operator[]>`SELECT * FROM operators WHERE email = ${e} AND NOT disabled`;
  // Same work whether or not the account exists.
  const ok = await verifyPassword(password, op?.passwordHash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await sql`INSERT INTO login_attempts (email, ip, ok) VALUES (${e}, ${ip}, ${ok && !!op})`;
  if (!ok || !op) return { ok: false, reason: 'invalid' };
  await sql`UPDATE operators SET last_login_at = now() WHERE id = ${op.id}`;
  return { ok: true, operator: op };
}

/**
 * Password typed again before a destructive action (delete, restore). A confirmation, not a second
 * factor: the same password, the same 5-failure lock as the login page.
 */
export async function confirmPassword(sql: Sql, operatorId: string, password: string, ip: string | null): Promise<'ok' | 'invalid' | 'throttled'> {
  const [op] = await sql<{ email: string; passwordHash: string | null }[]>`SELECT email, password_hash FROM operators WHERE id = ${operatorId} AND NOT disabled`;
  if (!op) return 'invalid';
  const [fails] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM login_attempts WHERE NOT ok AND email = ${op.email} AND at > now() - ${FAIL_WINDOW}::interval`;
  if ((fails?.n ?? 0) >= MAX_FAILS_PER_EMAIL) return 'throttled';
  const ok = await verifyPassword(password, op.passwordHash);
  await sql`INSERT INTO login_attempts (email, ip, ok) VALUES (${op.email}, ${ip}, ${ok})`;
  return ok ? 'ok' : 'invalid';
}

export async function createSession(sql: Sql, operatorId: string, meta: { ip: string | null; userAgent: string | null }): Promise<string> {
  const token = newToken();
  await sql`
    INSERT INTO operator_sessions (token_hash, operator_id, verified, expires_at, ip, user_agent)
    VALUES (${tokenHash(token)}, ${operatorId}, true, ${new Date(Date.now() + SESSION_TTL_MS)}, ${meta.ip}, ${meta.userAgent?.slice(0, 300) ?? null})`;
  await sql`DELETE FROM operator_sessions WHERE expires_at < now()`;
  return token;
}

export async function sessionFromToken(sql: Sql, token: string | undefined): Promise<{ session: Session; operator: Operator } | null> {
  if (!token || token.length > 100) return null;
  const [row] = await sql<(Session & { op: Operator })[]>`
    SELECT s.token_hash, s.operator_id, s.verified, s.expires_at, row_to_json(o) AS op
    FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
    WHERE s.token_hash = ${tokenHash(token)} AND s.expires_at > now() AND NOT o.disabled`;
  if (!row) return null;
  const o = row.op as unknown as Record<string, unknown>;
  const operator: Operator = {
    id: String(o.id),
    email: String(o.email),
    name: String(o.name),
    passwordHash: null,
    role: isRole(o.role) ? o.role : 'viewer',
    disabled: o.disabled === true,
    createdAt: new Date(String(o.created_at)),
    lastLoginAt: o.last_login_at ? new Date(String(o.last_login_at)) : null,
  };
  return { session: { tokenHash: row.tokenHash, operatorId: row.operatorId, verified: row.verified, expiresAt: row.expiresAt }, operator };
}

export async function endSession(sql: Sql, token: string | undefined): Promise<void> {
  if (token) await sql`DELETE FROM operator_sessions WHERE token_hash = ${tokenHash(token)}`;
}

export async function listOperators(sql: Sql): Promise<Operator[]> {
  return sql<Operator[]>`SELECT * FROM operators ORDER BY disabled, name`;
}

export async function setOperatorDisabled(sql: Sql, id: string, disabled: boolean): Promise<void> {
  await sql`UPDATE operators SET disabled = ${disabled} WHERE id = ${id}`;
  if (disabled) await sql`DELETE FROM operator_sessions WHERE operator_id = ${id}`;
}

export async function setOperatorRole(sql: Sql, id: string, role: Role): Promise<void> {
  await sql`UPDATE operators SET role = ${role} WHERE id = ${id}`;
}

/** Active owners other than `exceptId`: the last owner can be neither demoted nor disabled. */
export async function otherActiveOwners(sql: Sql, exceptId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM operators WHERE role = 'owner' AND NOT disabled AND id <> ${exceptId}`;
  return r?.n ?? 0;
}

// ---------- sessions ----------

export type SessionRow = { tokenHash: string; operatorId: string; operatorName: string; createdAt: Date; expiresAt: Date; ip: string | null; userAgent: string | null };

/** Open sessions, newest first: one operator's, or everyone's when operatorId is null. */
export async function listSessions(sql: Sql, operatorId: string | null): Promise<SessionRow[]> {
  return sql<SessionRow[]>`
    SELECT s.token_hash, s.operator_id, o.name AS operator_name, s.created_at, s.expires_at, s.ip, s.user_agent
    FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
    WHERE s.expires_at > now() AND s.verified ${operatorId ? sql`AND s.operator_id = ${operatorId}` : sql``}
    ORDER BY s.created_at DESC`;
}

/** Ends one session; `ownerOf` limits it to that operator's sessions. Returns the session's operator, or null. */
export async function revokeSession(sql: Sql, hash: string, ownerOf: string | null): Promise<string | null> {
  const [row] = await sql<{ operatorId: string }[]>`
    DELETE FROM operator_sessions WHERE token_hash = ${hash} ${ownerOf ? sql`AND operator_id = ${ownerOf}` : sql``}
    RETURNING operator_id`;
  return row?.operatorId ?? null;
}

// ---------- audit ----------

export async function audit(sql: Sql, input: { operatorId: string | null; agencyId?: string | null; action: string; detail?: Record<string, unknown>; ip?: string | null }): Promise<void> {
  await sql`
    INSERT INTO audit_log (operator_id, agency_id, action, detail, ip)
    VALUES (${input.operatorId}, ${input.agencyId ?? null}, ${input.action}, ${input.detail ? sql.json(input.detail as never) : null}, ${input.ip ?? null})`;
}
