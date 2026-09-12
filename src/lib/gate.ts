import { timingSafeEqual } from 'node:crypto';

// Shared request gates for the demo's server routes. Server-only (uses node:crypto).

export function json(status: number, payload: unknown) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

export function passcodeMatches(presented: string | null, expected: string) {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8'), b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Passcode then same-origin check. Returns a Response to send back, or null to continue.
 * Callers check their own configuration first so an unconfigured deployment answers 503, not 401.
 */
export function gate(req: Request, passcode: string): Response | null {
  if (!passcodeMatches(req.headers.get('x-assist-passcode'), passcode)) return json(401, { error: 'AI assist passcode is missing or incorrect.' });
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return json(403, { error: 'This route accepts requests from this app only.' });
  return null;
}
