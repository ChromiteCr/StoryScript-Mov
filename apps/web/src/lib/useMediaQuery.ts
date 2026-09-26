import { useSyncExternalStore } from 'react';

/** Live `matchMedia` result; false where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
  );
}

/** The Workspace grid breakpoint (Tailwind lg, 1024px): panels side by side above it, stacked below. */
export const WIDE_QUERY = '(min-width: 1024px)';
