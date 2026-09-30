import { useCallback, useMemo } from 'react';
import { useMutation, useQueries, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Board, BoardView, RasterView } from '@storyscript/contracts';
import { api, type InputOf } from './api.ts';
import type { ModelScope } from './models.ts';
import { mergeShotRasters, type RedrawQuality, type ShotRaster } from './labels-raster.ts';
import { boardKeys } from './queries-boards.ts';
import { keys } from './queries.ts';
import { trackJob } from './jobs.ts';

/**
 * AI pencil redraw data (FR-12, experimental): the image provider settings
 * mutations, the selected shot's rasters (every board version, so rasters
 * left behind by a structure change show as stale), redraw / adopt / reject,
 * and the export preference for the "AI 生成" corner mark.
 *
 * Keys live under ['boards', …] so a project switch drops them with the
 * board page's caches (queries.ts PROJECT_SCOPED_ROOTS).
 */

/** Same-origin post-processed raster PNG (routes/rasters.ts; session cookie). */
export const rasterImageUrl = (id: string) => `/api/v1/rasters/${encodeURIComponent(id)}/image`;

export const rasterKeys = {
  board: (boardId: string) => ['boards', 'rasters', boardId] as const,
};

const live = { staleTime: 0, gcTime: 60_000 } as const;

// ------------------------------------------------------------- settings ---

/** scope me: the signed-in member's own image model (hosted server only) */
export function useSaveImageProvider(scope: ModelScope = 'group') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'saveImageProvider'>) => (scope === 'me' ? api.call('saveMyImageProvider', input) : api.call('saveImageProvider', input)),
    onSuccess: (view) => {
      qc.setQueryData(scope === 'me' ? keys.myProviders : keys.providers, view);
      void qc.invalidateQueries({ queryKey: keys.health });
    },
  });
}

/** paid=false: GET /models only; paid=true: one smallest image (the caller confirmed the cost). */
export function useTestImageProvider(scope: ModelScope = 'group') {
  return useMutation({
    mutationFn: (paid: boolean) => (scope === 'me' ? api.call('testMyImageProvider', { paid }) : api.call('testImageProvider', { paid })),
  });
}

// -------------------------------------------------------------- rasters ---

export interface ShotRasters {
  list: ShotRaster[];
  pending: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * Rasters of the shot's board versions (newest version first, at most 6
 * versions — older rasters stay on disk and in the sidecars).
 */
export function useShotRasters(current: Pick<BoardView, 'id' | 'version'>, versions: readonly Pick<Board, 'id' | 'version'>[] | undefined): ShotRasters {
  const boards = useMemo(() => {
    const all = new Map<string, Pick<Board, 'id' | 'version'>>([[current.id, { id: current.id, version: current.version }]]);
    for (const v of versions ?? []) if (!all.has(v.id)) all.set(v.id, { id: v.id, version: v.version });
    return [...all.values()].sort((a, b) => b.version - a.version).slice(0, 6);
  }, [current.id, current.version, versions]);

  const combine = useCallback(
    (results: UseQueryResult<RasterView[]>[]): ShotRasters => ({
      list: mergeShotRasters(
        boards.map((b, i) => ({ board: b, rasters: results[i]?.data ?? [] })),
        current.id,
      ),
      pending: results[0]?.isPending ?? true,
      error: results.find((r) => r.error)?.error ?? null,
      refetch: () => {
        for (const r of results) void r.refetch();
      },
    }),
    [boards, current.id],
  );

  return useQueries({
    queries: boards.map((b) => ({
      queryKey: rasterKeys.board(b.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.call('listRasters', undefined, { signal, params: { id: b.id } }),
      ...live,
    })),
    combine,
  });
}

export const redrawSlot = (shotId: string) => `redraw:${shotId}`;

export function useRequestRedraw() {
  return useMutation({
    mutationFn: async (v: { boardId: string; shotId: string; quality: RedrawQuality }) => {
      const res = await api.call('requestRedraw', { confirmed: true, quality: v.quality }, { params: { id: v.boardId } });
      trackJob(redrawSlot(v.shotId), res.job_id);
      return res;
    },
  });
}

/** Replace one raster in its board's list; mirror adoption on the board list (BoardView.adopted_raster_id). */
function rasterChanged(qc: QueryClient, view: RasterView): void {
  qc.setQueryData<RasterView[]>(rasterKeys.board(view.board_id), (old) => {
    if (!old) return old;
    return old.map((r) => {
      if (r.id === view.id) return view;
      // adopting one returns the board's other adopted raster to candidate (server rule)
      if (view.status === 'adopted' && r.status === 'adopted') return { ...r, status: 'candidate' };
      return r;
    });
  });
  qc.setQueryData<BoardView[]>(boardKeys.list, (old) =>
    old?.map((b) => {
      if (b.id !== view.board_id) return b;
      if (view.status === 'adopted') return { ...b, adopted_raster_id: view.id };
      if (b.adopted_raster_id === view.id) return { ...b, adopted_raster_id: null };
      return b;
    }),
  );
  void qc.invalidateQueries({ queryKey: rasterKeys.board(view.board_id) });
}

export function useAdoptRaster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.call('adoptRaster', undefined, { params: { id } }),
    onSuccess: (view) => rasterChanged(qc, view),
  });
}

export function useRejectRaster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.call('rejectRaster', undefined, { params: { id } }),
    onSuccess: (view) => rasterChanged(qc, view),
  });
}

export function invalidateBoardRasters(qc: QueryClient, boardId: string): void {
  void qc.invalidateQueries({ queryKey: rasterKeys.board(boardId) });
  // adopted_raster_id lives on the board list
  void qc.invalidateQueries({ queryKey: boardKeys.list });
}

// ------------------------------------------------ export "AI 生成" mark ---
// Exports (board print, single-frame PNG) carry the "AI 生成" corner mark by
// default. The switch lives on the delivery page (M7); both sides read the
// same localStorage keys: per project first, then the global default.
// Anything but "off" means on; missing or unreadable storage means on.

export const AI_LABEL_PREF_KEY = 'storyscript.export.aiLabel';

export function aiLabelPrefKey(projectId: string): string {
  return `${AI_LABEL_PREF_KEY}:${projectId}`;
}

type Readable = Pick<Storage, 'getItem'>;

function storage(): Readable | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readAiLabelPref(projectId: string | null, store: Readable | null = storage()): boolean {
  if (!store) return true;
  try {
    const v = (projectId ? store.getItem(aiLabelPrefKey(projectId)) : null) ?? store.getItem(AI_LABEL_PREF_KEY);
    return v !== 'off';
  } catch {
    return true;
  }
}
