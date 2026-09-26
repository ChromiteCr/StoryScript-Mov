import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { BoardSpec } from '@storyscript/contracts';
import { frameSize } from '@storyscript/core';
import { arrowHandles, moveArrowEnd, moveSubjectFoot, pointerToFrame, subjectHandles } from '../../lib/board-editor.ts';
import type { BoardViewMode } from '../../lib/labels-boards.ts';
import { AiLayer, type AiLayerProps } from './AiLayer.tsx';
import { useBoardUrl } from './images.ts';
import type { EditorApi } from './useEditor.ts';

/**
 * The board picture plus its editing handles. The picture is the renderer's
 * SVG as an <img> (never touched); the handles are a separate React <svg>
 * layered on top with the same viewBox, styled by classes only (CSP).
 * Two direct manipulations: drag a person's foot point (ray ∩ ground) and
 * drag an arrow end. While dragging, the picture renders as structure
 * (fast); on release the chosen mode comes back. Handles are also keyboard
 * operable: focus one and use the arrow keys (Shift = bigger steps).
 * An AI raster (FR-12) can sit between the picture and the handles; it is
 * hidden while a handle is dragged so the structure shows through.
 */

type Drag = { kind: 'foot'; id: string } | { kind: 'arrow'; id: string; end: 'from' | 'to' };
type V2 = readonly [number, number];

/** A drag in progress: the pointer's start and the handle's true (unclamped) start, in frame units. */
interface Active {
  d: Drag;
  pointer: { fx: number; fy: number };
  origin: { fx: number; fy: number };
}

export interface BoardCanvasProps {
  spec: BoardSpec;
  mode: BoardViewMode;
  code: string;
  /** accessible description of the picture */
  alt: string;
  /** null: read-only (an older version) */
  editor: EditorApi | null;
  /** AI raster layer (adopted or compared); null = none */
  ai?: Omit<AiLayerProps, 'spec' | 'code'> | null;
}

const NUDGE = 0.004;

export function BoardCanvas({ spec, mode, code, alt, editor, ai = null }: BoardCanvasProps) {
  const dragging = editor?.dragging ?? false;
  const req = useMemo(() => ({ spec, mode: dragging ? ('structure' as const) : mode, overlay: true, code }), [spec, mode, dragging, code]);
  const url = useBoardUrl(req, dragging);
  const { W, H } = frameSize(spec.frame.aspect);
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGSVGElement>(null);
  const drag = useRef<Active | null>(null);
  const [px, setPx] = useState(900);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPx(Math.max(el.clientWidth, 1)));
    ro.observe(el);
    setPx(Math.max(el.clientWidth, 1));
    return () => ro.disconnect();
  }, []);

  const subjects = useMemo(() => subjectHandles(spec), [spec]);
  const arrows = useMemo(() => arrowHandles(spec), [spec]);
  const k = W / px; // viewBox units per screen pixel
  const sel = editor?.selection ?? null;

  const frameAt = (e: PointerEvent) => {
    const rect = layer.current!.getBoundingClientRect();
    return pointerToFrame(e.clientX, e.clientY, rect);
  };

  const apply = (d: Drag, fx: number, fy: number, base: BoardSpec) =>
    d.kind === 'foot' ? moveSubjectFoot(base, d.id, fx, fy) : moveArrowEnd(base, d.id, d.end, fx, fy);

  // Relative drags: the handle keeps its offset from the pointer, so grabbing a
  // handle that sits clamped at the frame edge never makes the person jump.
  const onDown = (d: Drag, at: V2) => (e: PointerEvent<SVGGElement>) => {
    if (!editor || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    layer.current?.setPointerCapture(e.pointerId);
    drag.current = { d, pointer: frameAt(e), origin: { fx: at[0] / W, fy: at[1] / H } };
    editor.select(d.kind === 'foot' ? { kind: 'subject', id: d.id } : { kind: 'arrow', id: d.id });
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const a = drag.current;
    if (!a || !editor) return;
    const { fx, fy } = frameAt(e);
    editor.preview(apply(a.d, a.origin.fx + fx - a.pointer.fx, a.origin.fy + fy - a.pointer.fy, editor.present));
  };

  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    const a = drag.current;
    if (!a || !editor) return;
    drag.current = null;
    if (layer.current?.hasPointerCapture(e.pointerId)) layer.current.releasePointerCapture(e.pointerId);
    editor.endPreview(e.type === 'pointercancel' ? null : a.d.kind === 'foot' ? '移动人物' : '移动箭头端点');
  };

  const onKey = (d: Drag, at: V2) => (e: KeyboardEvent<SVGGElement>) => {
    if (!editor) return;
    const step = e.shiftKey ? NUDGE * 5 : NUDGE;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const dv = delta[e.key];
    if (!dv) return;
    e.preventDefault();
    const fx = at[0] / W + dv[0];
    const fy = at[1] / H + dv[1];
    editor.commit(d.kind === 'foot' ? '移动人物' : '移动箭头端点', apply(d, fx, fy, editor.present));
  };

  // handle size in screen px: 8 on a desktop frame, down to 5 on a phone-width one
  const ring = Math.max(5, Math.min(8, px / 100)) * k;
  const hit = 18 * k;
  const sw = 2 * k;
  /** Keep handles inside the frame; one outside is drawn dashed at the edge. */
  const place = (p: V2): { at: V2; outside: boolean } => {
    const m = ring * 2.4;
    const x = Math.min(Math.max(p[0], m), W - m);
    const y = Math.min(Math.max(p[1], m), H - m);
    return { at: [x, y], outside: x !== p[0] || y !== p[1] };
  };

  return (
    <div ref={box} className="relative w-full select-none">
      <img src={url} alt={alt} draggable={false} className="block h-auto w-full" />
      {ai && !dragging ? <AiLayer spec={spec} code={code} {...ai} /> : null}
      {editor ? (
        <svg
          ref={layer}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full touch-none"
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) editor.select(null);
          }}
          aria-label="编辑手柄"
          role="group"
        >
          {arrows.map((a) => {
            const selected = sel?.kind === 'arrow' && sel.id === a.id;
            return (
              <g key={a.id} data-arrow-handle={a.id}>
                {selected ? (
                  <line x1={a.from[0]} y1={a.from[1]} x2={a.to[0]} y2={a.to[1]} strokeWidth={sw * 3} className="stroke-accent-strong/40" strokeLinecap="round" />
                ) : null}
                {(['from', 'to'] as const).map((end) => {
                  const truePos = end === 'from' ? a.from : a.to;
                  const { at: p, outside } = place(truePos);
                  const d: Drag = { kind: 'arrow', id: a.id, end };
                  return (
                    <g
                      key={end}
                      role="button"
                      tabIndex={0}
                      aria-label={`${end === 'from' ? '箭头起点' : '箭头终点'}（${a.id}）${outside ? '，在画外' : ''}，拖动或用方向键移动`}
                      data-handle={`arrow-${end}`}
                      data-arrow={a.id}
                      data-outside={outside || undefined}
                      onPointerDown={onDown(d, truePos)}
                      onKeyDown={onKey(d, truePos)}
                      onFocus={() => editor.select({ kind: 'arrow', id: a.id })}
                      className="cursor-grab outline-none focus-visible:[&>rect:last-child]:stroke-accent"
                    >
                      <circle cx={p[0]} cy={p[1]} r={hit} className="fill-transparent" />
                      <rect x={p[0] - ring * 0.8} y={p[1] - ring * 0.8} width={ring * 1.6} height={ring * 1.6} strokeWidth={sw * 2.2} className="fill-none stroke-paper" />
                      <rect
                        x={p[0] - ring * 0.8}
                        y={p[1] - ring * 0.8}
                        width={ring * 1.6}
                        height={ring * 1.6}
                        strokeWidth={sw}
                        strokeDasharray={outside ? `${sw * 2} ${sw * 1.5}` : undefined}
                        className={selected ? 'fill-accent-strong stroke-ink' : 'fill-paper stroke-ink'}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {subjects.map((s) => {
            if (!s.foot) return null;
            const selected = sel?.kind === 'subject' && sel.id === s.id;
            const d: Drag = { kind: 'foot', id: s.id };
            const { at, outside } = place(s.foot);
            const [x, y] = at;
            return (
              <g
                key={s.id}
                role="button"
                tabIndex={0}
                aria-label={`人物 ${s.badge} ${s.label} 的脚点${outside ? '（在画外）' : ''}，拖动或用方向键移动`}
                data-handle="foot"
                data-subject={s.id}
                data-outside={outside || undefined}
                onPointerDown={onDown(d, s.foot)}
                onKeyDown={onKey(d, s.foot)}
                onFocus={() => editor.select({ kind: 'subject', id: s.id })}
                className="cursor-grab outline-none focus-visible:[&>circle:last-child]:stroke-accent"
              >
                <circle cx={x} cy={y} r={hit} className="fill-transparent" />
                <ellipse cx={x} cy={y} rx={ring * 2.2} ry={ring * 0.9} strokeWidth={sw * 2.4} className="fill-none stroke-paper" />
                <ellipse
                  cx={x}
                  cy={y}
                  rx={ring * 2.2}
                  ry={ring * 0.9}
                  strokeWidth={sw}
                  strokeDasharray={outside ? `${sw * 3} ${sw * 2}` : undefined}
                  className={selected ? 'fill-accent-strong/35 stroke-ink' : 'fill-none stroke-ink'}
                />
                <circle cx={x} cy={y} r={ring * 0.45} strokeWidth={sw} className={selected ? 'fill-accent-strong stroke-ink' : 'fill-paper stroke-ink'} />
              </g>
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}
