import type { ReactNode } from 'react';
import type { CoverageStatus, TakeRating } from '@storyscript/contracts';
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  RotateCcw,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { COVERAGE_STATUS_LABEL, RATING_LABEL } from '../../lib/labels-media.ts';

/**
 * Small pieces shared by the set and media pages. Status is always icon +
 * text (never colour alone); colour tokens only tint the icon.
 */

export const RATING_ICON: Record<TakeRating, { icon: LucideIcon; tint: string }> = {
  good: { icon: CircleCheck, tint: 'text-ok' },
  alternate: { icon: CircleDot, tint: 'text-graphite-100' },
  reject: { icon: CircleX, tint: 'text-danger' },
  unrated: { icon: CircleDashed, tint: 'text-graphite-500' },
};

export function RatingBadge({ rating }: { rating: TakeRating }) {
  const { icon: Icon, tint } = RATING_ICON[rating];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-graphite-100">
      <Icon aria-hidden className={`size-3.5 ${tint}`} />
      {RATING_LABEL[rating]}
    </span>
  );
}

export const COVERAGE_ICON: Record<CoverageStatus, { icon: LucideIcon; tint: string }> = {
  planned: { icon: CircleDashed, tint: 'text-graphite-500' },
  attempted: { icon: Timer, tint: 'text-warn' },
  usable: { icon: CircleCheck, tint: 'text-ok' },
  needs_pickup: { icon: RotateCcw, tint: 'text-danger' },
  waived: { icon: CircleSlash, tint: 'text-graphite-300' },
};

export function CoverageBadge({ status, compact = false }: { status: CoverageStatus; compact?: boolean }) {
  const { icon: Icon, tint } = COVERAGE_ICON[status];
  return (
    <span className="relative inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-graphite-100">
      <Icon aria-hidden className={`size-3.5 ${tint}`} />
      {/* relative parent: the visually hidden label stays inside its scroll panel */}
      <span className={compact ? 'sr-only md:not-sr-only' : ''}>{COVERAGE_STATUS_LABEL[status]}</span>
    </span>
  );
}

/** Outlined label with an optional icon; `tone` only tints the icon. */
export function MiniTag({ children, icon: Icon, tone = 'neutral', title }: { children: ReactNode; icon?: LucideIcon; tone?: 'neutral' | 'warn' | 'danger' | 'ok'; title?: string }) {
  const tint = tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : tone === 'ok' ? 'text-ok' : 'text-graphite-300';
  return (
    <span
      title={title}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-control border border-graphite-700 px-1.5 text-xs whitespace-nowrap text-graphite-100"
    >
      {Icon ? <Icon aria-hidden className={`size-3 ${tint}`} /> : null}
      {children}
    </span>
  );
}

export const OfflineIcon = Ban;

/** ErrorNotice in the set/media wording (lib/errors.ts, context 'media'). */
export function MediaErrorNotice({ error, className = '' }: { error: unknown; className?: string }) {
  return <ErrorNotice error={error} context="media" className={className} />;
}

export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
