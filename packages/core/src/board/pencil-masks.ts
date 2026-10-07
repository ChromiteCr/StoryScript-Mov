/**
 * Auxiliary masks for the look metrics (L3–L7), drawn from the same tone plan
 * and painter order as the pencil renderer. Black = 0, white = selected.
 */
import type { BoardSpec } from '@storyscript/contracts';
import { clamp } from './math.ts';
import { buildPencilPlan, TIME_LOOK, type DepthBand } from './pencil-plan.ts';
import { attrs, el, gray, num, polyPath } from './svg.ts';

function open(W: number, H: number, width?: number): string {
  const w = width ?? W;
  return `<svg xmlns="http://www.w3.org/2000/svg"${attrs({ viewBox: `0 0 ${num(W)} ${num(H)}`, width: w, height: (w / W) * H })}>`;
}

export interface SubjectMaskOptions {
  width?: number;
  /** subjects to include (default: all) */
  ids?: readonly string[] | null;
  /** or: every subject in these depth bands */
  bands?: readonly DepthBand[] | null;
}

/**
 * Visible silhouettes of the selected people: white where they are seen,
 * black elsewhere — nearer props and people (painter order) occlude them.
 */
export function renderSubjectMask(spec: BoardSpec, o: SubjectMaskOptions = {}): string {
  const plan = buildPencilPlan(spec);
  const { W, H } = plan;
  const bandOf = new Map(plan.subjects.map((s) => [s.id, s.band]));
  const pick = (id: string) => {
    if (o.ids) return o.ids.includes(id);
    if (o.bands) return o.bands.includes(bandOf.get(id) ?? 'mg');
    return true;
  };
  const out: string[] = [open(W, H, o.width), el('rect', { x: 0, y: 0, width: W, height: H, fill: gray(0) })];
  for (const it of plan.items) {
    if (it.type === 'prop') for (const f of it.faces) out.push(el('path', { d: polyPath(f.pts), fill: gray(0) }));
    else if (it.type === 'subject') {
      const d = it.parts.map((p) => polyPath(p)).join('');
      if (d) out.push(el('path', { d, fill: gray(pick(it.item.id) ? 255 : 0) }));
    }
  }
  out.push('</svg>');
  return out.join('');
}

/** Tone map: grey = tone / 3 (white = darkest tone), ground continuous. */
export function renderToneMap(spec: BoardSpec, o: { width?: number } = {}): string {
  const plan = buildPencilPlan(spec);
  const { W, H } = plan;
  const tg = (t: number) => gray((clamp(t, 0, 3) / 3) * 255);
  const out: string[] = [open(W, H, o.width), el('rect', { x: 0, y: 0, width: W, height: H, fill: gray(0) })];
  const gp = plan.ground;
  if (gp) {
    out.push(
      `<defs><linearGradient${attrs({ id: 'tm-g', gradientUnits: 'userSpaceOnUse', x1: gp.from[0], y1: gp.from[1], x2: gp.to[0], y2: gp.to[1] })}>` +
        gp.stops.map((s) => el('stop', { offset: s.o, 'stop-color': tg(s.v) })).join('') +
        '</linearGradient></defs>',
    );
    out.push(el('path', { d: polyPath(gp.poly), fill: 'url(#tm-g)' }));
  }
  for (const it of plan.items) {
    if (it.type === 'prop') for (const f of it.faces) out.push(el('path', { d: polyPath(f.pts), fill: tg(f.tone) }));
    else if (it.type === 'shadow') out.push(el('path', { d: polyPath(it.pts), fill: tg(it.tone) }));
    else for (const r of it.regions) out.push(el('path', { d: polyPath(r.pts), fill: tg(r.tone) }));
  }
  // S5b: the night pool / dusk fade over everything, as the pencil hatch masks and toneRaster see them
  if (plan.pool) {
    const { cx, cy, rx, ry } = plan.pool;
    const n = TIME_LOOK.night;
    out.push(
      `<defs><radialGradient${attrs({ id: 'tm-n', gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: 1, gradientTransform: `translate(${num(cx)} ${num(cy)}) scale(${num(rx)} ${num(ry)})` })}>` +
        el('stop', { offset: n.inner, 'stop-color': tg(n.dark), 'stop-opacity': 0 }) +
        el('stop', { offset: 1, 'stop-color': tg(n.dark), 'stop-opacity': n.alpha }) +
        '</radialGradient></defs>',
      el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#tm-n)' }),
    );
  } else if (plan.dusk) {
    const d = TIME_LOOK.dusk;
    out.push(
      `<defs><linearGradient${attrs({ id: 'tm-d', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: num(plan.dusk.y1) })}>` +
        el('stop', { offset: 0, 'stop-color': tg(d.dark), 'stop-opacity': d.alpha }) +
        el('stop', { offset: 1, 'stop-color': tg(d.dark), 'stop-opacity': 0 }) +
        '</linearGradient></defs>',
      el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#tm-d)' }),
    );
  }
  out.push('</svg>');
  return out.join('');
}
