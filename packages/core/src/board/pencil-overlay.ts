/**
 * Pencil annotation layer: shot number, size·focal label, camera-move symbol,
 * subject arrows, eyelines and A/B badges, redrawn as "hand-lettered" pencil
 * marks (tapered, lightly jittered strokes) while text stays in a crisp
 * system font. Anchors and the overlay offset are exactly those of the
 * structure layer (overlay-geom.ts). Separate from the picture layer.
 */
import type { BoardSpec, Movement } from '@storyscript/contracts';
import { ZH_BOARD } from '../i18n/zh.ts';
import { rngFor } from '../util/random.ts';
import { DEG, type V2 } from './math.ts';
import { arrowPx, badgePlacement, FONT, guideLines, leaderLine, propAnchor } from './overlay-geom.ts';
import type { FrameScene } from './scene.ts';
import { looseLoop, sym, taperedStroke, type Rng } from './strokes.ts';
import { attrs, el, gray, num, polyPath, text } from './svg.ts';

const INK = gray(34);

interface Ctx {
  paper: string;
  ink: string;
}

function halo(d: string, ctx: Ctx, width: number): string {
  return el('path', { d, fill: ctx.paper, stroke: ctx.paper, 'stroke-width': width, 'stroke-opacity': 0.8, 'stroke-linejoin': 'round' });
}

function arrowHeadPoly(a: V2, b: V2, len: number, half: number, rng: Rng): { head: V2[]; shaftEnd: V2 } | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return null;
  const ux = dx / l;
  const uy = dy / l;
  const hl = Math.min(len, l * 0.6);
  const hw = half * (hl / len);
  const base: V2 = [b[0] - ux * hl * (1 + sym(rng) * 0.06), b[1] - uy * hl * (1 + sym(rng) * 0.06)];
  const j = () => sym(rng) * 1.2;
  return {
    head: [
      [b[0] + j(), b[1] + j()],
      [base[0] - uy * hw + j(), base[1] + ux * hw + j()],
      [b[0] - ux * hl * 0.72, b[1] - uy * hl * 0.72],
      [base[0] + uy * hw + j(), base[1] - ux * hw + j()],
    ],
    shaftEnd: [b[0] - ux * hl * 0.66, b[1] - uy * hl * 0.66],
  };
}

/** Split a 2-point line into dashes (on/off px). */
function dashes(a: V2, b: V2, on: number, off: number): V2[][] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const out: V2[][] = [];
  if (L < 1) return out;
  const ux = (b[0] - a[0]) / L;
  const uy = (b[1] - a[1]) / L;
  for (let s = 0; s < L; s += on + off) {
    const e = Math.min(L, s + on);
    if (e - s > 2) out.push([[a[0] + ux * s, a[1] + uy * s], [a[0] + ux * e, a[1] + uy * e]]);
  }
  return out;
}

function penArrow(
  pts: V2[],
  rng: Rng,
  ctx: Ctx,
  o: { width: number; head: number; dash?: [number, number]; heads?: 'end' | 'both' },
): string {
  if (pts.length < 2) return '';
  const endH = arrowHeadPoly(pts[pts.length - 2] as V2, pts[pts.length - 1] as V2, o.head, o.head * 0.42, rng);
  const startH = o.heads === 'both' ? arrowHeadPoly(pts[1] as V2, pts[0] as V2, o.head, o.head * 0.42, rng) : null;
  const shaft = pts.slice();
  if (endH) shaft[shaft.length - 1] = endH.shaftEnd;
  if (startH) shaft[0] = startH.shaftEnd;
  const runs = o.dash ? dashes(shaft[0] as V2, shaft[shaft.length - 1] as V2, o.dash[0], o.dash[1]) : [shaft];
  const strokes = runs.map((r) => taperedStroke(r, { w0: o.width, rng, overshoot: 0, wobble: o.dash ? 0.2 : 0.6, profile: 'taper', jitter: 0.12 }));
  const heads = [endH, startH].filter((h): h is NonNullable<typeof h> => !!h).map((h) => polyPath(h.head));
  const g: string[] = [];
  const all = [...strokes, ...heads].filter(Boolean).join('');
  if (!all) return '';
  g.push(halo(all, ctx, o.width + 7));
  for (const s of strokes) if (s) g.push(el('path', { d: s, fill: ctx.ink, 'fill-opacity': num(0.86 + sym(rng) * 0.06) }));
  for (const h of heads) g.push(el('path', { d: h, fill: ctx.ink, 'fill-opacity': 0.9, stroke: ctx.ink, 'stroke-width': 1, 'stroke-linejoin': 'round' }));
  return g.join('');
}

function penLine(pts: V2[], rng: Rng, ctx: Ctx, w: number, withHalo = true): string {
  const d = taperedStroke(pts, { w0: w, rng, overshoot: 0.02, wobble: 0.5 });
  if (!d) return '';
  return (withHalo ? halo(d, ctx, w + 6) : '') + el('path', { d, fill: ctx.ink, 'fill-opacity': 0.88 });
}

function cameraMove(m: Movement | null, W: number, H: number, rng: Rng, ctx: Ctx): string {
  if (!m || m === 'static') return '';
  const g: string[] = [`<g${attrs({ 'data-camera-move': m })}>`];
  const w = 3.4;
  switch (m) {
    case 'push_in':
    case 'pull_out': {
      for (const [cx, cy, dx, dy] of [
        [0, 0, 1, 1],
        [W, 0, -1, 1],
        [0, H, 1, -1],
        [W, H, -1, -1],
      ] as const) {
        const u = Math.SQRT1_2;
        const near: V2 = [cx + dx * u * 34, cy + dy * u * 34];
        const far: V2 = [cx + dx * u * 118, cy + dy * u * 118];
        g.push(penArrow(m === 'push_in' ? [near, far] : [far, near], rng, ctx, { width: w, head: 22 }));
      }
      break;
    }
    case 'pan':
      g.push(penArrow([[W * 0.38, 40], [W * 0.62, 40]], rng, ctx, { width: w, head: 22, heads: 'both' }));
      break;
    case 'tilt':
      g.push(penArrow([[W - 42, H * 0.3], [W - 42, H * 0.7]], rng, ctx, { width: w, head: 22, heads: 'both' }));
      break;
    case 'track': {
      const x0 = W * 0.36;
      const x1 = W * 0.64;
      const y0 = H - 36;
      const y1 = H - 22;
      g.push(penLine([[x0, y0], [x1, y0]], rng, ctx, 3));
      g.push(penLine([[x0, y1], [x1, y1]], rng, ctx, 3, false));
      for (let x = x0 + 14; x < x1 - 6; x += 30) g.push(penLine([[x + sym(rng), y0 - 5], [x + sym(rng), y1 + 5]], rng, ctx, 2, false));
      g.push(
        text(
          { x: W / 2, y: y0 - 14, 'font-family': FONT, 'font-size': 22, 'font-weight': 700, 'text-anchor': 'middle', fill: ctx.ink, stroke: ctx.paper, 'stroke-width': 5, 'paint-order': 'stroke', 'letter-spacing': 3 },
          ZH_BOARD.track,
        ),
      );
      break;
    }
    case 'crane': {
      g.push(penArrow([[46, H * 0.62], [46, H * 0.26]], rng, ctx, { width: w, head: 22, heads: 'both' }));
      g.push(penLine([[28, H * 0.7], [64, H * 0.7]], rng, ctx, 3.6));
      g.push(penLine([[46, H * 0.7], [46, H * 0.62]], rng, ctx, 3.6, false));
      break;
    }
    case 'handheld': {
      const pts: V2[] = [];
      const x0 = W - 260;
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        pts.push([x0 + 190 * t, 40 + 8 * Math.sin(t * Math.PI * 8)]);
      }
      g.push(penLine(pts, rng, ctx, 3.2));
      break;
    }
    case 'vehicle': {
      const x = W - 140;
      const y = H - 40;
      const body: V2[] = [
        [x, y],
        [x, y - 22],
        [x + 22, y - 24],
        [x + 34, y - 40],
        [x + 72, y - 40],
        [x + 86, y - 24],
        [x + 104, y - 20],
        [x + 104, y],
        [x, y],
      ];
      g.push(el('path', { d: polyPath(body), fill: ctx.paper, stroke: ctx.paper, 'stroke-width': 8, 'stroke-linejoin': 'round' }));
      g.push(penLine(body, rng, ctx, 3, false));
      for (const cx of [x + 24, x + 80]) {
        g.push(el('path', { d: polyPath(looseLoop(cx, y, 8, 8, rng, 16)), fill: ctx.ink, 'fill-opacity': 0.9 }));
      }
      break;
    }
    case 'orbit': {
      const cx = W / 2;
      const cy = H * 0.84;
      const rx = W * 0.3;
      const ry = H * 0.075;
      const pts: V2[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (150 + (300 * i) / 64) * DEG;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
      g.push(penArrow(pts, rng, ctx, { width: w, head: 24 }));
      break;
    }
    case 'aerial': {
      const cx = W - 96;
      const cy = 74;
      const k = 26;
      g.push(penLine([[cx - k, cy - k], [cx + k, cy + k]], rng, ctx, 3.4));
      g.push(penLine([[cx + k, cy - k], [cx - k, cy + k]], rng, ctx, 3.4, false));
      for (const [ox, oy] of [[-k, -k], [k, -k], [-k, k], [k, k]] as const) {
        const ring = taperedStroke(looseLoop(cx + ox, cy + oy, 10, 10, rng, 18), { w0: 2.6, rng, overshoot: 0, wobble: 0.2 });
        g.push(el('circle', { cx: cx + ox, cy: cy + oy, r: 11, fill: ctx.paper, 'fill-opacity': 0.92 }));
        if (ring) g.push(el('path', { d: ring, fill: ctx.ink, 'fill-opacity': 0.9 }));
      }
      g.push(el('path', { d: polyPath(looseLoop(cx, cy, 7, 7, rng, 14)), fill: ctx.ink, 'fill-opacity': 0.9 }));
      g.push(penArrow([[cx, cy + 58], [cx, cy + 120]], rng, ctx, { width: w, head: 22 }));
      break;
    }
    case 'dolly_zoom': {
      for (const [cx, cy, dx, dy] of [
        [0, 0, 1, 1],
        [W, 0, -1, 1],
        [0, H, 1, -1],
        [W, H, -1, -1],
      ] as const) {
        const u = Math.SQRT1_2;
        g.push(penArrow([[cx + dx * u * 34, cy + dy * u * 34], [cx + dx * u * 118, cy + dy * u * 118]], rng, ctx, { width: w, head: 22 }));
      }
      for (const [a, b] of [
        [[W / 2, 80], [W / 2, 30]],
        [[W / 2, H - 80], [W / 2, H - 30]],
        [[80, H / 2], [30, H / 2]],
        [[W - 80, H / 2], [W - 30, H / 2]],
      ] as const) {
        g.push(penArrow([a as V2, b as V2], rng, ctx, { width: w, head: 20 }));
      }
      g.push(
        text(
          { x: 120, y: H - 30, 'font-family': FONT, 'font-size': 22, 'font-weight': 700, fill: ctx.ink, stroke: ctx.paper, 'stroke-width': 5, 'paint-order': 'stroke', 'letter-spacing': 3 },
          ZH_BOARD.dollyZoom,
        ),
      );
      break;
    }
  }
  g.push('</g>');
  return g.join('');
}

export interface PencilOverlayOptions {
  paper: string;
  /** shot number / code shown top-left (when spec.overlay.show_code) */
  code?: string | null;
}

export function pencilOverlaySvg(spec: BoardSpec, scene: FrameScene, o: PencilOverlayOptions): string {
  const { W, H } = scene;
  const ov = spec.overlay;
  const ctx: Ctx = { paper: o.paper, ink: INK };
  const g: string[] = [`<g${attrs({ 'data-layer': 'overlay', transform: `translate(${num(ov.offset.x * W)} ${num(ov.offset.y * H)})` })}>`];
  for (const { guide, lines } of guideLines(spec, W, H)) {
    const d = lines.map((l) => polyPath(l, false)).join('');
    g.push(
      el('path', {
        d,
        fill: 'none',
        stroke: gray(110),
        'stroke-opacity': 0.55,
        'stroke-width': guide === 'thirds' ? 0.9 : 1.3,
        'stroke-dasharray': guide === 'thirds' ? '4 7' : '14 9',
        'data-guide': guide,
      }),
    );
  }
  for (const a of ov.arrows) {
    const pts = arrowPx(spec, scene, a);
    if (!pts) continue;
    const rng = rngFor(spec.seed, `overlay:arrow:${a.id}`);
    g.push(`<g${attrs({ 'data-arrow': a.id, 'data-kind': a.kind })}>`);
    g.push(
      a.kind === 'eyeline'
        ? penArrow(pts, rng, ctx, { width: 2.6, head: 18, dash: [13, 9] })
        : penArrow(pts, rng, ctx, { width: a.kind === 'camera_move' ? 3.4 : 5.2, head: 30 }),
    );
    g.push('</g>');
  }
  g.push(cameraMove(ov.camera_move, W, H, rngFor(spec.seed, 'overlay:camera-move'), ctx));
  for (const it of scene.items) {
    const r = 17;
    const c = badgePlacement(scene, it, r);
    if (!c || it.type !== 'subject') continue;
    const rng = rngFor(spec.seed, `overlay:badge:${it.id}`);
    const ring = taperedStroke(looseLoop(c[0], c[1], r, r, rng), { w0: 2.6, rng, overshoot: 0, wobble: 0.2 });
    g.push(`<g${attrs({ 'data-badge': it.id })}>`);
    g.push(el('circle', { cx: c[0], cy: c[1], r: r + 1, fill: ctx.paper, 'fill-opacity': 0.92 }));
    if (ring) g.push(el('path', { d: ring, fill: ctx.ink, 'fill-opacity': 0.9 }));
    g.push(text({ x: c[0], y: c[1] + r * 0.38, 'font-family': FONT, 'font-size': r * 1.12, 'font-weight': 700, 'text-anchor': 'middle', fill: ctx.ink }, it.badge));
    g.push('</g>');
  }
  for (const l of ov.labels) {
    // S5b: a callout naming a prop — a pencil leader from the tab to the object, ending in a dot
    const target = l.prop_id ? propAnchor(scene, l.prop_id) : null;
    if (target) {
      const box = tabBox(l.x * W, l.y * H, 26, l.text);
      const seg = leaderLine(box, target, 5);
      if (seg) {
        const rng = rngFor(spec.seed, `overlay:leader:${l.id}`);
        const d = taperedStroke(seg, { w0: 2.4, rng, overshoot: 0, wobble: 0.3 });
        if (d) g.push(halo(polyPath(seg, false), ctx, 7), el('path', { d, fill: ctx.ink, 'fill-opacity': 0.85, 'data-leader': l.id }));
        g.push(el('circle', { cx: target[0], cy: target[1], r: 5, fill: ctx.ink, stroke: ctx.paper, 'stroke-width': 2 }));
      }
    }
    g.push(labelTab(l.x * W, l.y * H, 26, l.prop_id ? 600 : 400, l.text, ctx, l.id, 'data-label'));
  }
  if (ov.show_code && o.code) {
    g.push(labelTab(22, 44, 30, 700, o.code, ctx, '1', 'data-code'));
  }
  g.push('</g>');
  return g.join('');
}

/** Rough advance width: CJK glyphs ≈ 1 em, everything else ≈ 0.66 em (errs wide). */
function textWidth(t: string, size: number): number {
  let w = 0;
  for (const ch of t) w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? size : size * 0.66;
  return w;
}

/** The paper tab of a label (labelTab's geometry). */
function tabBox(x: number, baseline: number, size: number, t: string): { x: number; y: number; w: number; h: number } {
  const padX = size * 0.3;
  const padY = size * 0.22;
  return { x: x - padX, y: baseline - size * 0.86 - padY, w: textWidth(t, size) + padX * 2, h: size + padY * 2 };
}

/**
 * Label on a small paper tab (like a note pinned to the board). A solid tab
 * reads cleanly over dark silhouettes, where a paper-coloured text stroke
 * smears into the hatching.
 */
function labelTab(x: number, baseline: number, size: number, weight: number, t: string, ctx: Ctx, id: string, attr: 'data-label' | 'data-code'): string {
  const padX = size * 0.3;
  const padY = size * 0.22;
  const w = textWidth(t, size) + padX * 2;
  const h = size + padY * 2;
  const top = baseline - size * 0.86 - padY;
  return (
    `<g${attrs({ [attr]: id })}>` +
    el('rect', { x: x - padX, y: top, width: w, height: h, rx: 3, fill: ctx.paper, 'fill-opacity': 0.9 }) +
    text({ x, y: baseline, 'font-family': FONT, 'font-size': size, 'font-weight': weight, fill: ctx.ink }, t) +
    '</g>'
  );
}
