/**
 * Group join links on a hosted server: `…/#join=ABCD-2345`. The code is taken
 * out of the address bar at once (so it does not stay in history) and kept
 * in sessionStorage until the person has signed in and decided whether to
 * join. Storage can be unavailable (private windows): then it lives in memory.
 */

const KEY = 'ssm-pending-join';
let memory: string | null = null;

/** `ABCD-2345` from `#join=ABCD-2345` (also `#a=1&join=…`), or null. */
export function readJoinFromHash(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  for (const part of hash.slice(1).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq) !== 'join') continue;
    try {
      const code = decodeURIComponent(part.slice(eq + 1)).trim();
      return /^[A-Za-z0-9-]{4,40}$/.test(code) ? code.toUpperCase() : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function pendingJoin(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setPendingJoin(code: string | null): void {
  memory = code;
  try {
    if (code) sessionStorage.setItem(KEY, code);
    else sessionStorage.removeItem(KEY);
  } catch {
    // memory copy is enough for this tab
  }
}

/** Move a join code from the address bar into pending storage; true when one was there. */
export function takeJoinFromLocation(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>,
): boolean {
  const code = readJoinFromHash(location.hash);
  if (!code) return false;
  setPendingJoin(code);
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  return true;
}
