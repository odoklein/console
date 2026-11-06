// VENDORED from the CRM repo, lib/instance/auth.ts (signing half only). The CRM verifies
// exactly this canonical string; change both or neither.
//
//   X-Instance-Timestamp: <unix seconds>
//   X-Instance-Signature: v1=<hex hmac-sha256 of `${ts}.${METHOD}.${pathWithQuery}.${sha256hex(body)}`>

import { createHash, createHmac } from 'node:crypto';

export type InstanceBody = string | Uint8Array | null | undefined;

function bodyBytes(body: InstanceBody): Uint8Array {
  if (body == null) return new Uint8Array(0);
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

export function signInstanceRequest(input: { secret: string; method: string; pathWithQuery: string; body?: InstanceBody; timestamp?: number }) {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const bodyHash = createHash('sha256').update(bodyBytes(input.body)).digest('hex');
  const canonical = `${timestamp}.${input.method.toUpperCase()}.${input.pathWithQuery}.${bodyHash}`;
  const mac = createHmac('sha256', input.secret).update(canonical).digest('hex');
  return { 'X-Instance-Timestamp': String(timestamp), 'X-Instance-Signature': `v1=${mac}` };
}
