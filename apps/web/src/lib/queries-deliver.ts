import { useCallback, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ExportCsvKind } from '@storyscript/core';
import { api, ApiClientError, isAbortError, parseResponse } from './api.ts';

/**
 * Deliver page data and downloads (FR-10). Keys live under ['deliver', …]
 * with staleTime/gcTime 0: the page always shows what the exports would
 * contain right now, and nothing survives into another project.
 *
 * The CSV and JSON files come from the server (GET /api/v1/export/…, the same
 * core/export builders the pages use); they are fetched and handed to the
 * browser as a download so an error shows on the page instead of being saved
 * as a file.
 */

export const deliverKeys = {
  all: ['deliver'] as const,
  shots: ['deliver', 'shots'] as const,
  boards: ['deliver', 'boards'] as const,
  plans: ['deliver', 'plans'] as const,
  plan: (id: string) => ['deliver', 'plans', id] as const,
  takes: ['deliver', 'takes'] as const,
  links: ['deliver', 'links'] as const,
  coverage: ['deliver', 'coverage'] as const,
};

const live = { staleTime: 0, gcTime: 0 } as const;

export function useDeliverShots() {
  return useQuery({ queryKey: deliverKeys.shots, queryFn: ({ signal }) => api.call('listShots', undefined, { signal }), ...live });
}

export function useDeliverBoards() {
  return useQuery({ queryKey: deliverKeys.boards, queryFn: ({ signal }) => api.call('listBoards', undefined, { signal }), ...live });
}

export function useDeliverPlans() {
  return useQuery({ queryKey: deliverKeys.plans, queryFn: ({ signal }) => api.call('listPlans', undefined, { signal }), ...live });
}

export function useDeliverPlan(id: string | null) {
  return useQuery({
    queryKey: deliverKeys.plan(id ?? 'none'),
    queryFn: ({ signal }) => api.call('getPlan', undefined, { signal, params: { id: id! } }),
    enabled: id !== null,
    ...live,
  });
}

export function useDeliverTakes() {
  return useQuery({ queryKey: deliverKeys.takes, queryFn: ({ signal }) => api.call('listTakes', undefined, { signal }), ...live });
}

export function useDeliverLinks() {
  return useQuery({ queryKey: deliverKeys.links, queryFn: ({ signal }) => api.call('listLinks', undefined, { signal }), ...live });
}

export function useDeliverCoverage() {
  return useQuery({ queryKey: deliverKeys.coverage, queryFn: ({ signal }) => api.call('coverage', undefined, { signal }), ...live });
}

// ------------------------------------------------------------------ export URLs

export const PROJECT_JSON_URL = '/api/v1/export/project.json';

export function exportCsvUrl(kind: ExportCsvKind, opts: { bom: boolean; planId?: string | null }): string {
  const q = new URLSearchParams();
  if (opts.bom) q.set('bom', '1');
  if (kind === 'callsheet' && opts.planId) q.set('plan_id', opts.planId);
  const s = q.toString();
  return `/api/v1/export/csv/${kind}${s ? `?${s}` : ''}`;
}

// ------------------------------------------------------------------ downloads

/** Save text as a file (browser download of a blob). */
export function saveText(name: string, text: string, type: string): void {
  saveBlob(name, new Blob([text], { type }));
}

export function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * GET an export and save it under the server's file name. Errors come back
 * as ApiClientError (same envelope handling as the API client).
 */
export async function downloadExport(url: string, fallbackName: string, filenameOf: (header: string | null) => string | null): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', headers: { Accept: '*/*' } });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ApiClientError({ code: 'NETWORK_ERROR', message: '无法连接本地服务', status: 0, retryable: true, cause: e });
  }
  if (!res.ok) {
    await parseResponse(res); // throws the server's error
    throw new ApiClientError({ code: 'BAD_RESPONSE', message: `HTTP ${res.status}`, status: res.status, retryable: false });
  }
  const name = filenameOf(res.headers.get('content-disposition')) ?? fallbackName;
  saveBlob(name, await res.blob());
  return name;
}

// ------------------------------------------------------------------ AI badge preference

/**
 * "AI 生成" badge on exported boards (FR-12: on by default). A per-viewer
 * preference in localStorage; the board print view reads it through
 * readAiBadgePref() when it places adopted AI images.
 */
export const AI_BADGE_PREF_KEY = 'storyscript.export.aiBadge';
const PREF_EVENT = 'storyscript:ai-badge';

export function readAiBadgePref(): boolean {
  try {
    return window.localStorage.getItem(AI_BADGE_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeAiBadgePref(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(AI_BADGE_PREF_KEY);
    else window.localStorage.setItem(AI_BADGE_PREF_KEY, 'off');
  } catch {
    // storage blocked: the default (on) stays in effect
  }
  window.dispatchEvent(new Event(PREF_EVENT));
}

function subscribePref(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === AI_BADGE_PREF_KEY) onChange();
  };
  window.addEventListener(PREF_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PREF_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useAiBadgePref(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribePref, readAiBadgePref, () => true);
  const set = useCallback((v: boolean) => writeAiBadgePref(v), []);
  return [on, set];
}

// ------------------------------------------------------------------ CSV BOM preference

const BOM_PREF_KEY = 'storyscript.export.csvBom';

export function readBomPref(): boolean {
  try {
    return window.localStorage.getItem(BOM_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeBomPref(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(BOM_PREF_KEY);
    else window.localStorage.setItem(BOM_PREF_KEY, 'off');
  } catch {
    // per-viewer convenience only
  }
}
