import { memo, useMemo, useRef, type KeyboardEvent } from 'react';
import type { BoardView, Shot } from '@storyscript/contracts';
import { PencilLine } from 'lucide-react';
import type { BoardViewMode } from '../../lib/labels-boards.ts';
import { SHOT_SIZE_LABEL } from '../../lib/labels.ts';
import { useInView, useLazyBoardUrl } from './images.ts';

/**
 * Left column: every shot's board as a thumbnail, grouped by scene in
 * narrative order. Thumbnails render lazily (only once scrolled near) and are
 * cached by structure hash. A stale board carries the corner mark "镜头已改";
 * a hand-edited one a small pencil; one whose version has an adopted AI
 * raster an "AI" mark. The selected card has the accent ring.
 */

export interface SceneGroup {
  id: string;
  label: string;
  boards: BoardView[];
}

const Thumb = memo(function Thumb({ board, mode }: { board: BoardView; mode: BoardViewMode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref);
  const req = useMemo(() => ({ spec: board.spec, mode, overlay: true, code: board.shot_code }), [board.spec, mode, board.shot_code]);
  const url = useLazyBoardUrl(req, seen);
  return (
    <span ref={ref} className="relative block w-full overflow-hidden rounded-control bg-paper">
      {url ? (
        <img src={url} alt="" draggable={false} decoding="async" className="block h-auto w-full" />
      ) : (
        <span className="block aspect-[2.39/1] w-full animate-pulse bg-paper motion-reduce:animate-none" />
      )}
      {board.adopted_raster_id ? (
        <span title="已采用 AI 图" className="absolute bottom-1 left-1 inline-flex h-5 items-center rounded-control bg-graphite-950/90 px-1.5 text-xs font-medium text-graphite-100">
          AI
        </span>
      ) : null}
      {board.stale ? (
        <span className="absolute top-1 right-1 inline-flex h-5 items-center gap-1 rounded-control border border-warn/70 bg-graphite-950/90 px-1.5 text-xs text-graphite-100">
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
          镜头已改
        </span>
      ) : null}
    </span>
  );
});

export function ShotStrip({
  groups,
  shots,
  selectedShotId,
  mode,
  onSelect,
}: {
  groups: SceneGroup[];
  shots: Map<string, Shot>;
  selectedShotId: string | null;
  mode: BoardViewMode;
  onSelect: (shotId: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);

  // ↑/↓ (and ←/→) step through the cards in narrative order
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button[data-shot]') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const to = back ? at - 1 : fwd ? at + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const b = buttons[Math.max(0, Math.min(buttons.length - 1, to))];
    b?.focus();
    if (b?.dataset.shot) onSelect(b.dataset.shot);
  };

  return (
    <div ref={root} onKeyDown={onKeyDown} className="flex flex-col gap-3 p-2">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          <h3 className="mb-1.5 flex items-baseline justify-between gap-2 px-0.5 text-xs font-medium text-graphite-300">
            <span className="min-w-0 truncate" title={g.label}>
              {g.label}
            </span>
            <span className="shrink-0 tabular-nums">{g.boards.length} 格</span>
          </h3>
          <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-1">
            {g.boards.map((b) => {
              const shot = shots.get(b.shot_id);
              const selected = b.shot_id === selectedShotId;
              return (
                <li key={b.shot_id} className="min-w-0">
                  <button
                    type="button"
                    data-shot={b.shot_id}
                    aria-pressed={selected}
                    aria-label={`镜 ${b.shot_code}${shot ? ` ${SHOT_SIZE_LABEL[shot.fields.shot_size]}` : ''}${b.stale ? '，镜头已改' : ''}${b.adopted_raster_id ? '，已采用 AI 图' : ''}`}
                    onClick={() => onSelect(b.shot_id)}
                    className={
                      'flex w-full min-w-0 flex-col gap-1 rounded-panel border p-1 text-left ' +
                      (selected ? 'border-accent bg-graphite-800' : 'border-transparent hover:border-graphite-700 hover:bg-graphite-800/60')
                    }
                  >
                    <Thumb board={b} mode={mode} />
                    <span className="flex min-w-0 items-center gap-1.5 px-0.5 text-xs">
                      <span className="font-medium text-graphite-100 tabular-nums">{b.shot_code}</span>
                      <span className="min-w-0 truncate text-graphite-300">
                        {shot ? SHOT_SIZE_LABEL[shot.fields.shot_size] : ''}
                        {shot?.fields.action ? ` · ${shot.fields.action}` : ''}
                      </span>
                      {b.user_edited ? <PencilLine aria-label="手动调整过" className="ml-auto size-3 shrink-0 text-graphite-300" /> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
