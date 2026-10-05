import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardView, BoardSpec } from '@storyscript/contracts';
import { api, isApiClientError } from './api.ts';
import { markSaveFailed, markSaved, markSaving } from './saveStatus.ts';

/**
 * Board page data (FR-04). Keys live under ['boards', …] so this module never
 * collides with other pages' caches. staleTime 0 (other pages edit shots, so
 * coming back always refetches) and gcTime 0 (nothing from one project
 * survives into the next). Writes report to the save indicator only after
 * the server committed.
 */

export const boardKeys = {
  all: ['boards'] as const,
  list: ['boards', 'list'] as const,
  versions: (shotId: string) => ['boards', 'versions', shotId] as const,
  shots: ['boards', 'shots'] as const,
  script: ['boards', 'script'] as const,
  scriptVersions: ['boards', 'script-versions'] as const,
};

const live = { staleTime: 0, gcTime: 0 } as const;

export function useBoards() {
  return useQuery({ queryKey: boardKeys.list, queryFn: ({ signal }) => api.call('listBoards', undefined, { signal }), ...live });
}

export function useBoardVersions(shotId: string | null) {
  return useQuery({
    queryKey: boardKeys.versions(shotId ?? 'none'),
    queryFn: ({ signal }) => api.call('shotBoardVersions', undefined, { signal, params: { id: shotId! } }),
    enabled: shotId !== null,
    ...live,
  });
}

export function useBoardShots() {
  return useQuery({ queryKey: boardKeys.shots, queryFn: ({ signal }) => api.call('listShots', undefined, { signal }), ...live });
}

export function useBoardScript() {
  return useQuery({ queryKey: boardKeys.script, queryFn: ({ signal }) => api.call('currentScript', undefined, { signal }), ...live });
}

export function useBoardScriptVersions() {
  return useQuery({ queryKey: boardKeys.scriptVersions, queryFn: ({ signal }) => api.call('scriptVersions', undefined, { signal }), ...live });
}

async function saving<T>(fn: () => Promise<T>): Promise<T> {
  markSaving();
  try {
    const out = await fn();
    markSaved();
    return out;
  } catch (e) {
    markSaveFailed(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Replace the shot's entry in the list with the newest version the server returned. */
export function boardChanged(qc: QueryClient, view: BoardView): void {
  qc.setQueryData<BoardView[]>(boardKeys.list, (old) => old?.map((b) => (b.shot_id === view.shot_id ? view : b)));
  void qc.invalidateQueries({ queryKey: boardKeys.versions(view.shot_id) });
}

/** A 409 means another tab saved first: refetch so the page shows the newest version. */
function onBoardError(qc: QueryClient, e: unknown): void {
  if (isApiClientError(e) && e.code === 'REVISION_CONFLICT') void qc.invalidateQueries({ queryKey: boardKeys.all });
}

export function useSaveBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { boardId: string; revision: number; spec: BoardSpec }) =>
      saving(() => api.call('saveBoard', { expected_revision: v.revision, spec: v.spec }, { params: { id: v.boardId } })),
    onSuccess: (view) => boardChanged(qc, view),
    onError: (e) => onBoardError(qc, e),
  });
}

export function useKeepBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { boardId: string; revision: number }) =>
      saving(() => api.call('keepBoard', { expected_revision: v.revision }, { params: { id: v.boardId } })),
    onSuccess: (view) => boardChanged(qc, view),
    onError: (e) => onBoardError(qc, e),
  });
}

export function useRegenerateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shotId: string) => saving(() => api.call('regenerateBoard', undefined, { params: { id: shotId } })),
    onSuccess: (view) => boardChanged(qc, view),
    onError: (e) => onBoardError(qc, e),
  });
}

/**
 * S4c 用新画法重排: lay out again every board of the scene (null = all) that an
 * older renderer drew and nobody edited. The list, and the shown shot's
 * versions, are refetched: new versions replace the old as the newest.
 */
export function useRelayoutBoards() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sceneId: string | null) => saving(() => api.call('relayoutBoards', { scene_id: sceneId })),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardKeys.all }),
  });
}

export function isRevisionConflict(e: unknown): boolean {
  return isApiClientError(e) && e.code === 'REVISION_CONFLICT';
}
