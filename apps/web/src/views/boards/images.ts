import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { BoardSpec, RenderMode } from '@storyscript/contracts';
import { contentHash, PICTURE_VERSION, renderBoard, structureHash } from '@storyscript/core';

/**
 * Board pictures in the browser: core renderBoard → SVG string → Blob URL →
 * <img> (CSP: img-src 'self' blob:, and no markup is injected into the page).
 *
 * Cache: key = mode + PICTURE_VERSION + structure_hash (picture layer) +
 * overlay hash + code, so an unchanged board is never rendered twice. The
 * picture version is in the key because structure_hash is deliberately
 * independent of how the pictures are drawn: new drawing code (S4c figures and
 * sets) never serves a picture the old code made. LRU over blob URLs; the
 * oldest URLs are revoked. Drag previews use a separate transient URL that is
 * revoked as soon as the next frame replaces it (never cached).
 * Thumbnails render lazily (IntersectionObserver) through a queue that runs
 * one render per task, so a long shot list never blocks input.
 */

export interface RenderRequest {
  spec: BoardSpec;
  mode: RenderMode;
  overlay?: boolean;
  code?: string | null;
}

const MAX_URLS = 160;
const cache = new Map<string, string>();

export function renderKey(r: RenderRequest): string {
  const overlay = r.overlay !== false;
  return [r.mode, PICTURE_VERSION, structureHash(r.spec), overlay ? contentHash(r.spec.overlay) : 'no-overlay', r.code ?? ''].join('|');
}

export function renderSvg(r: RenderRequest): string {
  return renderBoard(r.spec, r.mode, { overlay: r.overlay !== false, code: r.code ?? null });
}

function toUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}

export function cachedUrl(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/** Render (or reuse) a cached blob URL. */
export function boardUrl(r: RenderRequest, key = renderKey(r)): string {
  const hit = cachedUrl(key);
  if (hit) return hit;
  const url = toUrl(renderSvg(r));
  cache.set(key, url);
  while (cache.size > MAX_URLS) {
    const first = cache.entries().next().value;
    if (!first) break;
    cache.delete(first[0]);
    URL.revokeObjectURL(first[1]);
  }
  return url;
}

// ------------------------------------------------------------------ queue

const queue: (() => void)[] = [];
let pumping = false;

function step(): void {
  const job = queue.shift();
  if (job) job();
  if (queue.length) setTimeout(step, 0);
  else pumping = false;
}

function schedule(job: () => void): void {
  queue.push(job);
  if (!pumping) {
    pumping = true;
    setTimeout(step, 0);
  }
}

// ------------------------------------------------------------------ hooks

/** True once the element has scrolled near the viewport (then stays true). */
export function useInView(ref: RefObject<Element | null>, rootMargin = '200px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}

/** Lazily rendered, cached board picture (thumbnails, print cells). */
export function useLazyBoardUrl(r: RenderRequest, visible: boolean): string | null {
  const key = useMemo(() => renderKey(r), [r]);
  const [state, setState] = useState<{ key: string; url: string } | null>(() => {
    const hit = cachedUrl(key);
    return hit ? { key, url: hit } : null;
  });
  const req = useRef(r);
  req.current = r;
  useEffect(() => {
    if (!visible) return;
    const hit = cachedUrl(key);
    if (hit) {
      setState({ key, url: hit });
      return;
    }
    let live = true;
    schedule(() => {
      if (!live) return;
      setState({ key, url: boardUrl(req.current, key) });
    });
    return () => {
      live = false;
    };
  }, [key, visible]);
  return state && state.key === key ? state.url : state?.url ?? null;
}

/**
 * The editor canvas: rendered synchronously. `transient` frames (while a
 * handle or slider is being dragged) bypass the cache and are revoked when the
 * next one replaces them.
 */
export function useBoardUrl(r: RenderRequest, transient: boolean): string {
  const last = useRef<string | null>(null);
  const url = useMemo(() => (transient ? toUrl(renderSvg(r)) : boardUrl(r)), [r, transient]);
  useEffect(() => {
    const prev = last.current;
    last.current = transient ? url : null;
    if (prev && prev !== url) {
      // let the new frame decode before dropping the previous one
      window.setTimeout(() => URL.revokeObjectURL(prev), 1000);
    }
  }, [url, transient]);
  useEffect(
    () => () => {
      if (last.current) URL.revokeObjectURL(last.current);
    },
    [],
  );
  return url;
}
