import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Board, BoardSpec, BoardView, Job } from '@storyscript/contracts';
import { isTerminalJob, markJobHandled, useTrackedJob } from '../../lib/jobs.ts';
import { adoptedRaster, clampOpacity, leftBehindAdopted, rasterStaleFor, type AiViewMode, type ShotRaster } from '../../lib/labels-raster.ts';
import { useJob } from '../../lib/queries.ts';
import { boardKeys } from '../../lib/queries-boards.ts';
import { redrawSlot, useShotRasters } from '../../lib/queries-raster.ts';

/**
 * State of the AI layer for the selected shot (FR-12):
 *  - the rasters of every version of the shot's board;
 *  - the redraw job being followed (module-level tracker, so switching
 *    shots or pages keeps it); when it ends the lists refresh and a new
 *    candidate opens in the onion-skin comparison;
 *  - which raster the frame shows: the compared candidate, else the board
 *    version's adopted raster; the view mode and onion opacity.
 */

interface ViewState {
  shotId: string;
  compareId: string | null;
  mode: AiViewMode;
  /** 0–100 */
  opacity: number;
}

export interface RasterWorkbench {
  list: ShotRaster[];
  pending: boolean;
  error: unknown;
  refetch: () => void;
  job: Job | null;
  /** the adopted raster of the board version shown */
  adopted: ShotRaster | null;
  /** adopted raster of an older version (left behind by a structure change) */
  leftBehind: ShotRaster | null;
  /** the left-behind raster no longer matches the frame */
  leftBehindStale: boolean;
  compared: ShotRaster | null;
  /** what the frame shows: compared ?? adopted (only rasters with an image) */
  shown: ShotRaster | null;
  mode: AiViewMode;
  opacity: number;
  /** shown raster no longer matches the frame being edited */
  stale: boolean;
  compare: (id: string | null) => void;
  setMode: (m: AiViewMode) => void;
  setOpacity: (pct: number) => void;
  /** after adopting: show the adopted raster with its annotations */
  adoptedShown: () => void;
}

const fresh = (shotId: string): ViewState => ({ shotId, compareId: null, mode: 'overlay', opacity: 50 });

export function useRasterWorkbench(board: BoardView, versions: readonly Board[] | undefined, spec: BoardSpec): RasterWorkbench {
  const qc = useQueryClient();
  const rasters = useShotRasters(board, versions);
  const slot = redrawSlot(board.shot_id);
  const tracked = useTrackedJob(slot);
  const job = useJob(tracked?.jobId ?? null);
  const [view, setView] = useState<ViewState>(() => fresh(board.shot_id));

  // another shot: start over (adjusting state during render)
  let v = view;
  if (view.shotId !== board.shot_id) {
    v = fresh(board.shot_id);
    setView(v);
  }

  // a new newest version (save, regenerate, keep): the server's stale flags change
  const version = `${board.id}:${board.revision}`;
  const lastVersion = useRef(version);
  useEffect(() => {
    if (lastVersion.current === version) return;
    lastVersion.current = version;
    void qc.invalidateQueries({ queryKey: ['boards', 'rasters'] });
  }, [version, qc]);

  // the followed job finished: refresh the lists once, open a new candidate for comparison
  const data = job.data ?? null;
  useEffect(() => {
    if (!data || !tracked || tracked.handled || data.id !== tracked.jobId || !isTerminalJob(data)) return;
    markJobHandled(slot, data.id);
    void qc.invalidateQueries({ queryKey: ['boards', 'rasters'] });
    void qc.invalidateQueries({ queryKey: boardKeys.list });
    if (data.status === 'succeeded' && data.result_ref) {
      const id = data.result_ref;
      setView((s) => ({ ...s, compareId: id, mode: 'onion', opacity: 50 }));
    }
  }, [data, tracked, slot, qc]);

  const withImage = (r: ShotRaster | null) => (r && r.image_url ? r : null);
  const adopted = withImage(adoptedRaster(rasters.list, board));
  const compared = v.compareId ? withImage(rasters.list.find((r) => r.id === v.compareId) ?? null) : null;
  const shown = compared ?? adopted;
  const leftBehind = adopted ? null : leftBehindAdopted(rasters.list);
  // a compared raster that is also the adopted one behaves like the adopted display
  const mode: AiViewMode = shown ? v.mode : 'lines';

  const compare = useCallback((id: string | null) => {
    setView((s) => (id === null ? { ...s, compareId: null, mode: 'overlay' } : { ...s, compareId: id, mode: 'onion' }));
  }, []);
  const setMode = useCallback((m: AiViewMode) => setView((s) => ({ ...s, mode: m })), []);
  const setOpacity = useCallback((pct: number) => setView((s) => ({ ...s, opacity: clampOpacity(pct) })), []);
  const adoptedShown = useCallback(() => setView((s) => ({ ...s, compareId: null, mode: 'overlay' })), []);

  return {
    list: rasters.list,
    pending: rasters.pending,
    error: rasters.error,
    refetch: rasters.refetch,
    job: data && tracked && data.id === tracked.jobId ? data : null,
    adopted,
    leftBehind,
    leftBehindStale: leftBehind ? rasterStaleFor(leftBehind, spec) : false,
    compared,
    shown,
    mode,
    opacity: v.opacity,
    stale: shown ? rasterStaleFor(shown, spec) : false,
    compare,
    setMode,
    setOpacity,
    adoptedShown,
  };
}
