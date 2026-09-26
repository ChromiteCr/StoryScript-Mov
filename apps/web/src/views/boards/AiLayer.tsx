import { useMemo } from 'react';
import type { BoardSpec } from '@storyscript/contracts';
import { frameSize } from '@storyscript/core';
import { AI_BADGE_TEXT, aiBadgeBox, overlayOnlyUrl } from './raster-layers.ts';

/**
 * AI raster layers over a board frame (FR-12). One SVG in frame units laid
 * over the frame picture: the raster (post-processed on the server to the
 * frame size), optionally the vector annotation layer, and the "AI 生成"
 * corner mark. Presentation attributes only (CSP: no inline style), so the
 * onion-skin opacity is an `opacity` attribute.
 */

const PAPER = '#efebe2';
const INK = '#25262a';

export type AiLayerMode = 'overlay' | 'onion' | 'ai';

export interface AiLayerProps {
  spec: BoardSpec;
  code: string | null;
  /** same-origin raster PNG */
  url: string;
  mode: AiLayerMode;
  /** onion-skin opacity 0..1 */
  opacity: number;
  /** draw the "AI 生成" corner mark */
  badge: boolean;
  /** the frame changed since the raster was drawn */
  stale?: boolean;
  /** raster decoded (print waits for it) */
  onLoad?: () => void;
}

export function AiBadge({ spec, code, stale = false }: { spec: BoardSpec; code: string | null; stale?: boolean }) {
  const text = stale ? `${AI_BADGE_TEXT} · 构图已改` : AI_BADGE_TEXT;
  const b = aiBadgeBox(spec, code, text);
  return (
    <g data-ai-badge={stale ? 'stale' : ''}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={4} fill={INK} fillOpacity={0.92} />
      <text x={b.tx} y={b.baseline} fontSize={b.font} fontWeight={700} fill={PAPER} fontFamily='"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'>
        {text}
      </text>
    </g>
  );
}

export function AiLayer({ spec, code, url, mode, opacity, badge, stale = false, onLoad }: AiLayerProps) {
  const { W, H } = frameSize(spec.frame.aspect);
  const overlayUrl = useMemo(() => (mode === 'overlay' ? overlayOnlyUrl(spec, code) : null), [mode, spec, code]);
  const shown = mode !== 'onion' || opacity > 0;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden={badge && shown ? undefined : true}
      role={badge && shown ? 'img' : undefined}
      aria-label={badge && shown ? (stale ? 'AI 生成（构图已改）' : 'AI 生成') : undefined}
      data-ai-layer={mode}
      data-ai-opacity={mode === 'onion' ? Math.round(opacity * 100) : 100}
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {mode !== 'onion' ? <rect x={0} y={0} width={W} height={H} fill={PAPER} /> : null}
      <image href={url} x={0} y={0} width={W} height={H} preserveAspectRatio="none" opacity={mode === 'onion' ? opacity : 1} onLoad={onLoad} onError={onLoad} />
      {overlayUrl ? <image href={overlayUrl} x={0} y={0} width={W} height={H} preserveAspectRatio="none" /> : null}
      {badge && shown ? <AiBadge spec={spec} code={code} stale={stale} /> : null}
    </svg>
  );
}
