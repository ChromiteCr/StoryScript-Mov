import { useSyncExternalStore } from 'react';

/**
 * Hash routing without a router library: `#/script`, `#/boards`, …
 * The six workflow stages (order and labels in stages.ts) plus settings.
 */

export const VIEWS = ['script', 'boards', 'plan', 'set', 'media', 'deliver', 'settings'] as const;
export type View = (typeof VIEWS)[number];

const NAVIGATE_EVENT = 'storyscript:navigate';

export function parseView(hash: string): View | null {
  const m = /^#\/([a-z]+)\/?$/.exec(hash);
  const name = m?.[1];
  return name !== undefined && (VIEWS as readonly string[]).includes(name) ? (name as View) : null;
}

/** Go to a view, or `null` for the bare URL (home when no project is open). */
export function navigate(view: View | null): void {
  if (view) {
    window.location.hash = `#/${view}`;
    return;
  }
  const { pathname, search } = window.location;
  window.history.pushState(null, '', `${pathname}${search}`);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

export function useView(): View | null {
  return useSyncExternalStore(subscribe, () => parseView(window.location.hash));
}
