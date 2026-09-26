import type { HealthInfo } from '@storyscript/contracts';
import { ApiClientError, isUnauthorized, type ApiClient } from './api.ts';

/**
 * Session bootstrap (SPEC §6): the terminal prints `/#t=<token>`; the page
 * trades it for an HttpOnly cookie via POST /api/v1/session, then drops the
 * fragment so the token leaves the address bar and history entry.
 */

export type BootResult =
  | { kind: 'ready'; health: HealthInfo }
  | { kind: 'expired' }
  | { kind: 'unreachable'; error: ApiClientError };

export interface BootDeps {
  client: ApiClient;
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
}

/** Reads `t` from `#t=<token>` (also `#a=1&t=…`). Does not treat `+` as space. */
export function readTokenFromHash(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  for (const part of hash.slice(1).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq) !== 't') continue;
    try {
      const token = decodeURIComponent(part.slice(eq + 1));
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
  return null;
}

function stripFragment({ location, history }: BootDeps): void {
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}

function asClientError(e: unknown): ApiClientError {
  if (e instanceof ApiClientError) return e;
  return new ApiClientError({ code: 'NETWORK_ERROR', message: String(e), status: 0, retryable: true, cause: e });
}

export async function bootstrapSession(deps: BootDeps): Promise<BootResult> {
  const token = readTokenFromHash(deps.location.hash);
  let exchanged = false;
  if (token !== null) {
    try {
      await deps.client.call('session', { token });
      exchanged = true;
      stripFragment(deps);
    } catch {
      // Fall through: an existing cookie may still be valid; health decides.
    }
  }

  try {
    const health = await deps.client.call('health');
    // Cookie from an earlier visit works; the stale token is not needed.
    if (token !== null && !exchanged) stripFragment(deps);
    return { kind: 'ready', health };
  } catch (e) {
    if (isUnauthorized(e)) return { kind: 'expired' };
    return { kind: 'unreachable', error: asClientError(e) };
  }
}

// ---- global "session expired" flag: any 401 after boot flips it ----

let expired = false;
const listeners = new Set<() => void>();

export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  for (const l of listeners) l();
}

/** Called before re-bootstrapping with a fresh token. */
export function resetSessionExpired(): void {
  if (!expired) return;
  expired = false;
  for (const l of listeners) l();
}

export function isSessionExpired(): boolean {
  return expired;
}

export function subscribeSessionExpired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
