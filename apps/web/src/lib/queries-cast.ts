import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type InputOf } from './api.ts';
import { describeError } from './errors.ts';
import { markSaved, markSaveFailed, markSaving } from './saveStatus.ts';

/**
 * S3b — who plays whom. Two reads:
 *  - suggestions: the script's cast list read against the characters
 *    (keyed under ['entities', …], so anything that refetches the entities
 *    refetches them, and a project switch drops them with the rest);
 *  - sync preview: what the plan's performers and locations still need
 *    (keyed under ['plan', …], next to the resources it is computed from).
 * Both are recomputed by the server on every read, so staleTime is 0.
 */

export const castKeys = {
  /** same root as the entity list (lib/queries.ts keys.entities) */
  entities: ['entities'] as const,
  suggestions: ['entities', 'cast'] as const,
  sync: ['plan', 'cast-sync'] as const,
  /** every plan-page query (lib/queries-plan.ts planKeys.all) */
  plan: ['plan'] as const,
};

const live = { staleTime: 0 } as const;

async function saving<T>(fn: () => Promise<T>): Promise<T> {
  markSaving();
  try {
    const out = await fn();
    markSaved();
    return out;
  } catch (e) {
    markSaveFailed(describeError(e).title);
    throw e;
  }
}

/** An entity was created or edited (its actor may have changed): the suggestions and the sync preview are stale. */
export function invalidateCast(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: castKeys.suggestions });
  void qc.invalidateQueries({ queryKey: castKeys.sync });
}

export function useCastSuggestions() {
  return useQuery({ queryKey: castKeys.suggestions, queryFn: ({ signal }) => api.call('castSuggestions', undefined, { signal }), ...live });
}

/** Fill in the ticked cast-list lines. Characters may be created or split, so the entity lists refetch too. */
export function useApplyCast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'applyCast'>) => saving(() => api.call('applyCast', input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: castKeys.entities });
      void qc.invalidateQueries({ queryKey: castKeys.plan });
    },
  });
}

export function useCastSync() {
  return useQuery({ queryKey: castKeys.sync, queryFn: ({ signal }) => api.call('castSyncPreview', undefined, { signal }), ...live });
}

/**
 * Apply the previewed sync. Resources changed, so every plan query refetches
 * (as after useSaveResource). A 409 means the script or the plan moved since
 * the preview: it is refetched and the dialog says so.
 */
export function useApplyCastSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'applyCastSync'>) => saving(() => api.call('applyCastSync', input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: castKeys.plan });
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: castKeys.sync });
    },
  });
}
