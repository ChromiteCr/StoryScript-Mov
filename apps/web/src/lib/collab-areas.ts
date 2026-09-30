import type { CollabArea } from '@storyscript/contracts';

/**
 * S4a — which cached queries an area of the change feed stands for. When a
 * teammate's write moves an area, every query under one of its roots is
 * marked stale and the visible ones refetch. Pure data and helpers (no DOM,
 * no React); test/s4a-sync-web.test.ts checks that every query root the app
 * uses is covered by some area, so a new page cannot be forgotten.
 *
 * A root is a query-key prefix: ['boards'] stands for every ['boards', …].
 */

export type QueryRoot = readonly string[];

export const AREA_ROOTS: Readonly<Record<CollabArea, readonly QueryRoot[]>> = {
  script: [['script'], ['boards', 'script'], ['boards', 'script-versions'], ['plan', 'script'], ['m6', 'script']],
  shots: [['shots'], ['shot-revisions'], ['boards', 'shots'], ['plan', 'shots'], ['m6', 'shots'], ['deliver', 'shots']],
  boards: [['boards'], ['deliver', 'boards']],
  plan: [['plan'], ['m6', 'plans'], ['m6', 'setups'], ['deliver', 'plans']],
  takes: [['m6', 'takes'], ['m6', 'coverage'], ['deliver', 'takes'], ['deliver', 'coverage']],
  media: [['m6', 'roots'], ['m6', 'assets'], ['m6', 'links'], ['m6', 'coverage'], ['deliver', 'links'], ['deliver', 'coverage']],
  entities: [['entities'], ['plan', 'entities'], ['plan', 'cast-sync']],
  styles: [['styles']],
  drafts: [['drafts'], ['plan', 'draft']],
  jobs: [['jobs'], ['m6', 'job'], ['plan', 'job']],
  project: [['project'], ['health']],
  settings: [['settings'], ['health']],
  members: [['me']],
  comments: [['comments']],
};

export const COLLAB_AREAS = Object.keys(AREA_ROOTS) as CollabArea[];

/**
 * Query roots that belong to no area on purpose: they are about the account or
 * the site, not the project a teammate edits.
 */
export const UNSYNCED_ROOTS: readonly string[] = ['site', 'group-preview', 'projects'];

/** The roots of these areas, each once (areas share some, e.g. ['health']). */
export function rootsOfAreas(areas: Iterable<CollabArea>): QueryRoot[] {
  const seen = new Set<string>();
  const out: QueryRoot[] = [];
  for (const area of areas) {
    for (const root of AREA_ROOTS[area] ?? []) {
      const id = root.join('\u0000');
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(root);
    }
  }
  return out;
}

/** Everything: after a server restart or a gap in the feed. */
export function allRoots(): QueryRoot[] {
  return rootsOfAreas(COLLAB_AREAS);
}

/** Whether a query key sits under a root of some area (or is deliberately not synced). */
export function isCoveredKey(key: readonly unknown[]): boolean {
  if (typeof key[0] === 'string' && UNSYNCED_ROOTS.includes(key[0])) return true;
  return COLLAB_AREAS.some((area) => AREA_ROOTS[area].some((root) => root.length <= key.length && root.every((part, i) => key[i] === part)));
}
