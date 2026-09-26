import { useRef, type KeyboardEvent } from 'react';
import type { MediaAssetView } from '@storyscript/contracts';
import { AudioLines, Clapperboard, FileQuestion, Image as ImageIcon, TriangleAlert, type LucideIcon } from 'lucide-react';
import { KIND_LABEL, NEEDS_PROXY_LABEL } from '../../lib/labels-media.ts';
import { clipSummary, fileName, formatClipDuration } from './model.ts';
import { MiniTag, OfflineIcon } from './shared.tsx';

/**
 * Library grid: poster frame (lazy), file name, duration, codec, and the
 * facts a reviewer needs at a glance — needs a proxy, offline, changed,
 * links. The selected card carries the accent ring (primary selection).
 */

const KIND_ICON: Record<MediaAssetView['kind'], LucideIcon> = {
  video: Clapperboard,
  audio: AudioLines,
  image: ImageIcon,
  other: FileQuestion,
};

function Poster({ a }: { a: MediaAssetView }) {
  const Icon = KIND_ICON[a.kind];
  return (
    <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-control bg-graphite-950">
      {a.poster_url ? (
        <img src={a.poster_url} alt="" loading="lazy" decoding="async" className={`h-full w-full object-contain ${a.availability === 'offline' ? 'opacity-40 grayscale' : ''}`} />
      ) : (
        <Icon aria-hidden className="size-6 text-graphite-500" strokeWidth={1.5} />
      )}
      {a.probe?.duration_s ? (
        <span className="absolute right-1 bottom-1 rounded-control bg-graphite-950/85 px-1 text-xs text-graphite-100 tabular-nums">{formatClipDuration(a.probe.duration_s)}</span>
      ) : null}
    </span>
  );
}

export function AssetGrid({ assets, selectedId, onSelect }: { assets: readonly MediaAssetView[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLUListElement>(null);

  // ←/→ step through cards (row-major); Home/End jump
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-asset]') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const b = buttons[Math.max(0, Math.min(buttons.length - 1, to))];
    b?.focus();
    if (b?.dataset.asset) onSelect(b.dataset.asset);
  };

  return (
    <ul ref={ref} onKeyDown={onKeyDown} aria-label="素材" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {assets.map((a) => {
        const selected = a.id === selectedId;
        const s = clipSummary(a);
        const proxy = a.kind === 'video' && !a.playable_direct;
        return (
          <li key={a.id} className="min-w-0">
            <button
              type="button"
              data-asset={a.id}
              aria-pressed={selected}
              onClick={() => onSelect(a.id)}
              className={
                'flex w-full min-w-0 flex-col gap-1.5 rounded-panel border p-1.5 text-left ' +
                (selected ? 'border-accent bg-graphite-800' : 'border-transparent hover:border-graphite-700 hover:bg-graphite-800/60')
              }
            >
              <Poster a={a} />
              <span className="min-w-0 px-0.5">
                <span className="block truncate text-xs font-medium text-graphite-100" title={a.rel_path}>
                  {fileName(a.rel_path)}
                </span>
                <span className="block truncate text-xs text-graphite-300">
                  {[s.codec || KIND_LABEL[a.kind], s.resolution].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="flex min-h-5 flex-wrap gap-1 px-0.5">
                {a.availability === 'offline' ? (
                  <MiniTag icon={OfflineIcon} tone="danger">
                    离线
                  </MiniTag>
                ) : null}
                {a.hash_status === 'source_changed' ? (
                  <MiniTag icon={TriangleAlert} tone="warn">
                    已变化
                  </MiniTag>
                ) : null}
                {proxy ? <MiniTag>{NEEDS_PROXY_LABEL}</MiniTag> : null}
                {a.link_count > 0 ? <MiniTag>关联 {a.link_count}</MiniTag> : null}
                {a.candidate_count > 0 ? <MiniTag>候选 {a.candidate_count}</MiniTag> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
