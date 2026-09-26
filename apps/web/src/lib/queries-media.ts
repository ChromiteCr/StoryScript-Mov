import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Job, MediaAssetView, Plan, Setup } from '@storyscript/contracts';
import { api, isApiClientError, type InputOf } from './api.ts';
import { isJobInFlight } from './jobs.ts';
import { markSaved, markSaveFailed, markSaving } from './saveStatus.ts';

/**
 * TanStack Query hooks for the set log and the media library (M6). Keys live
 * under 'm6' so other tracks' caches never collide; every write goes through
 * the save indicator ("已保存" only after the server committed, FR-01).
 */

export const mediaKeys = {
  all: ['m6'] as const,
  shots: ['m6', 'shots'] as const,
  script: ['m6', 'script'] as const,
  takes: ['m6', 'takes'] as const,
  plans: ['m6', 'plans'] as const,
  setups: ['m6', 'setups'] as const,
  roots: ['m6', 'roots'] as const,
  assets: ['m6', 'assets'] as const,
  search: (q: string, filter: AssetFilter) => ['m6', 'assets', 'search', q, filter] as const,
  links: ['m6', 'links'] as const,
  coverage: ['m6', 'coverage'] as const,
  job: (id: string) => ['m6', 'job', id] as const,
};

export type AssetFilter = 'all' | 'unlinked' | 'candidate' | 'offline';

const FRESH = { staleTime: 5_000 };

export function useMediaShots() {
  return useQuery({ queryKey: mediaKeys.shots, queryFn: ({ signal }) => api.call('listShots', undefined, { signal }), ...FRESH });
}

export function useMediaScript() {
  return useQuery({ queryKey: mediaKeys.script, queryFn: ({ signal }) => api.call('currentScript', undefined, { signal }), ...FRESH });
}

export function useTakes() {
  return useQuery({ queryKey: mediaKeys.takes, queryFn: ({ signal }) => api.call('listTakes', undefined, { signal }), ...FRESH });
}

/** A server without the plan routes yet answers 404: that simply means "no plan". */
async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch (e) {
    if (isApiClientError(e) && e.code === 'NOT_FOUND') return [];
    throw e;
  }
}

export function usePlansForSet() {
  return useQuery({
    queryKey: mediaKeys.plans,
    queryFn: ({ signal }): Promise<Plan[]> => orEmpty(api.call('listPlans', undefined, { signal })),
    retry: false,
    ...FRESH,
  });
}

export function useSetupsForSet() {
  return useQuery({
    queryKey: mediaKeys.setups,
    queryFn: ({ signal }): Promise<Setup[]> => orEmpty(api.call('listSetups', undefined, { signal })),
    retry: false,
    ...FRESH,
  });
}

export function useRoots() {
  return useQuery({ queryKey: mediaKeys.roots, queryFn: ({ signal }) => api.call('listRoots', undefined, { signal }), ...FRESH });
}

export function useAssets() {
  return useQuery({ queryKey: mediaKeys.assets, queryFn: ({ signal }) => api.call('listAssets', undefined, { signal }), ...FRESH });
}

const FILTER_INPUT: Record<AssetFilter, Pick<InputOf<'searchAssets'>, 'availability' | 'linked'>> = {
  all: { availability: null, linked: null },
  unlinked: { availability: null, linked: 'unlinked' },
  candidate: { availability: null, linked: 'candidate' },
  offline: { availability: 'offline', linked: null },
};

/** LIKE search on file name + path; the plain list when there is nothing to filter. */
export function useAssetSearch(q: string, filter: AssetFilter) {
  const trimmed = q.trim();
  const plain = trimmed === '' && filter === 'all';
  const all = useAssets();
  const search = useQuery({
    queryKey: mediaKeys.search(trimmed, filter),
    queryFn: ({ signal }): Promise<MediaAssetView[]> => api.call('searchAssets', { q: trimmed, ...FILTER_INPUT[filter] }, { signal }),
    enabled: !plain,
    placeholderData: (prev) => prev,
    ...FRESH,
  });
  return plain ? all : search;
}

export function useLinks() {
  return useQuery({ queryKey: mediaKeys.links, queryFn: ({ signal }) => api.call('listLinks', undefined, { signal }), ...FRESH });
}

export function useCoverage() {
  return useQuery({ queryKey: mediaKeys.coverage, queryFn: ({ signal }) => api.call('coverage', undefined, { signal }), ...FRESH });
}

// ------------------------------------------------------------------ writes

function tracked<A, R>(fn: (a: A) => Promise<R>): (a: A) => Promise<R> {
  return async (a) => {
    markSaving();
    try {
      const r = await fn(a);
      markSaved();
      return r;
    } catch (e) {
      markSaveFailed(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
}

/** After anything that changes takes, links or files, coverage is stale too. */
function refreshMedia(qc: QueryClient, what: readonly (keyof typeof mediaKeys)[]): void {
  for (const k of what) {
    const key = mediaKeys[k];
    if (typeof key !== 'function') void qc.invalidateQueries({ queryKey: key });
  }
  void qc.invalidateQueries({ queryKey: mediaKeys.coverage });
}

export function useCreateTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked((input: InputOf<'createTake'>) => api.call('createTake', input)),
    onSuccess: () => refreshMedia(qc, ['takes']),
  });
}

export function useUpdateTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked(({ id, input }: { id: string; input: InputOf<'updateTake'> }) => api.call('updateTake', input, { params: { id } })),
    onSettled: () => refreshMedia(qc, ['takes']),
  });
}

export function useAddRoot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked((input: InputOf<'addRoot'>) => api.call('addRoot', input)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mediaKeys.roots }),
  });
}

export function useScanRoot() {
  return useMutation({ mutationFn: (id: string) => api.call('scanRoot', undefined, { params: { id } }) });
}

export function useCheckRoot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked((id: string) => api.call('checkRoot', undefined, { params: { id } })),
    onSuccess: () => refreshMedia(qc, ['assets', 'links']),
  });
}

export function useBuildCandidates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked((input: InputOf<'buildCandidates'>) => api.call('buildCandidates', input)),
    onSuccess: () => refreshMedia(qc, ['links', 'assets']),
  });
}

export function useCreateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked((input: InputOf<'createLink'>) => api.call('createLink', input)),
    onSuccess: () => refreshMedia(qc, ['links', 'assets']),
  });
}

export function useReviewLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked(({ id, input }: { id: string; input: InputOf<'reviewLink'> }) => api.call('reviewLink', input, { params: { id } })),
    onSettled: () => refreshMedia(qc, ['links', 'assets']),
  });
}

export function useAddCoverageDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tracked(({ shotId, input }: { shotId: string; input: InputOf<'addCoverageDecision'> }) =>
      api.call('addCoverageDecision', input, { params: { id: shotId } }),
    ),
    onSuccess: () => refreshMedia(qc, []),
  });
}

/**
 * Poll one job each second until it is terminal (FR-11). While it runs the
 * library is refreshed every few seconds so scanned clips appear as they land.
 */
export function useJobProgress(jobId: string | null, onDone?: (job: Job) => void) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: mediaKeys.job(jobId ?? 'none'),
    queryFn: ({ signal }) => api.call('getJob', undefined, { signal, params: { id: jobId! } }),
    enabled: jobId !== null,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data && !isJobInFlight(query.state.data) ? false : 1000),
  });
  const ticks = useRef(0);
  const done = useRef<string | null>(null);
  const job = q.data ?? null;
  useEffect(() => {
    if (!job) return;
    if (isJobInFlight(job)) {
      ticks.current += 1;
      if (ticks.current % 3 === 0) void qc.invalidateQueries({ queryKey: mediaKeys.assets });
      return;
    }
    if (done.current === job.id) return;
    done.current = job.id;
    refreshMedia(qc, ['assets', 'links', 'roots']);
    onDone?.(job);
  }, [job, qc, onDone]);
  return q;
}
