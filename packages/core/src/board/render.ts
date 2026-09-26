/**
 * BoardSpec → SVG string. Pure: no DOM, no IO, byte-identical for identical input.
 *
 * Rules (CSP + control-image friendly):
 *  - presentation attributes only (no `style` attribute, no <style>);
 *  - greyscale only (#rrggbb with r = g = b);
 *  - every text node / attribute value escaped; coordinates fixed to 2 decimals;
 *  - overlay: false ⇒ no <text> at all (AI control image).
 *
 * Modes: 'structure' and 'topview' are implemented; 'pencil' currently falls
 * back to 'structure' (M2 replaces it without changing this signature).
 */
import type { BoardArrow, BoardSpec, Movement, Pose, RenderMode, Silhouette } from '@storyscript/contracts';
import { cyrb53 } from '../util/hash.ts';
import { ZH_BOARD, ZH_PROP_KIND } from '../i18n/zh.ts';
import { cameraBasis, hFov, projectPoint, projectSegment, unprojectToPlane } from './camera.ts';
import { isEnvProp, STREET } from './layout.ts';
import { clamp, DEG, type V2, type V3 } from './math.ts';
import { buildPuppet, poseTopY, type PuppetView } from './puppets.ts';
import { buildFrameScene, frameSize, propWorldOrigin, type FrameScene, type PropItem, type SubjectItem } from './scene.ts';
import { attrs, el, gray, num, polyPath, text } from './svg.ts';

export interface RenderOptions {
  /** output width attribute in px (viewBox stays 1840 wide) */
  width?: number;
  /** annotation layer (badges, arrows, camera-move symbol, labels, guides). Default true. */
  overlay?: boolean;
  /** paper background rect. Default true. */
  background?: boolean;
}

export const RENDERER_VERSION = 'board-m1.0';

const FONT = 'PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Microsoft YaHei, sans-serif';
const C = {
  paper: gray(255),
  ink: gray(0),
  line: gray(26),
  envLine: gray(118),
  envDecor: gray(165),
  decor: gray(80),
  grid: gray(214),
  road: gray(168),
  mark: gray(178),
  horizon: gray(140),
  hair: gray(189),
  inner: gray(96),
  guide: gray(140),
  halo: gray(255),
  wedge: gray(238),
  envFill: gray(242),
};

export function renderBoard(spec: BoardSpec, mode: RenderMode, opts: RenderOptions = {}): string {
  if (mode === 'topview') return renderTopview(spec, opts);
  return renderStructure(spec, opts);
}

function svgOpen(W: number, H: number, width: number | undefined): string {
  const w = width ?? W;
  const h = (w / W) * H;
  return `<svg xmlns="http://www.w3.org/2000/svg"${attrs({ viewBox: `0 0 ${num(W)} ${num(H)}`, width: w, height: h })}>`;
}

function specId(spec: BoardSpec, mode: string): string {
  return `${mode[0]}${cyrb53(JSON.stringify(spec)).toString(36)}`;
}

// ---------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------

function renderStructure(spec: BoardSpec, opts: RenderOptions): string {
  const scene = buildFrameScene(spec);
  const { W, H } = scene;
  const overlay = opts.overlay !== false;
  const clipId = specId(spec, 'structure');
  const out: string[] = [svgOpen(W, H, opts.width)];
  out.push(`<defs><clipPath${attrs({ id: clipId })}>${el('rect', { x: 0, y: 0, width: W, height: H })}</clipPath></defs>`);
  if (opts.background !== false) out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: C.paper }));
  out.push(`<g${attrs({ 'clip-path': `url(#${clipId})` })}>`);
  out.push(groundSvg(scene));
  for (const it of scene.items) out.push(it.type === 'prop' ? propSvg(it) : subjectSvg(it));
  out.push('</g>');
  out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: 'none', stroke: C.ink, 'stroke-width': 3 }));
  if (overlay) out.push(overlaySvg(spec, scene));
  out.push('</svg>');
  return out.join('');
}

function linesPath(lines: readonly (readonly V2[])[]): string {
  return lines.map((l) => polyPath(l, false)).join('');
}

function groundSvg(scene: FrameScene): string {
  const g: string[] = ['<g data-layer="ground">'];
  const by = (k: string) => scene.ground.filter((l) => l.kind === k).map((l) => l.pts);
  const grid = by('grid');
  if (grid.length) g.push(el('path', { d: linesPath(grid), fill: 'none', stroke: C.grid, 'stroke-width': 1 }));
  const road = by('road');
  if (road.length) g.push(el('path', { d: linesPath(road), fill: 'none', stroke: C.road, 'stroke-width': 1.4 }));
  const marks = by('mark');
  if (marks.length) g.push(el('path', { d: linesPath(marks), fill: 'none', stroke: C.mark, 'stroke-width': 1.3, 'stroke-linecap': 'round' }));
  if (scene.horizon) g.push(el('path', { d: polyPath(scene.horizon, false), fill: 'none', stroke: C.horizon, 'stroke-width': 1.6 }));
  g.push('</g>');
  return g.join('');
}

function propSvg(it: PropItem): string {
  const stroke = it.env ? C.envLine : C.line;
  const sw = it.env ? 1.4 : 2.2;
  const g: string[] = [`<g${attrs({ 'data-prop': it.id, 'data-kind': it.kind })}>`];
  for (const f of it.faces) {
    g.push(el('path', { d: polyPath(f.pts), fill: C.paper, stroke, 'stroke-width': sw, 'stroke-linejoin': 'round' }));
    if (f.decor.length)
      g.push(el('path', { d: linesPath(f.decor), fill: 'none', stroke: it.env ? C.envDecor : C.decor, 'stroke-width': it.env ? 0.9 : 1.2 }));
  }
  g.push('</g>');
  return g.join('');
}

function subjectStroke(it: SubjectItem): { out: number; inner: number } {
  const h = it.heightPx;
  return { out: clamp(h * 0.012, 1.8, 6), inner: clamp(h * 0.0045, 0.8, 2.2) };
}

function subjectSvg(it: SubjectItem): string {
  const { out, inner } = subjectStroke(it);
  const g: string[] = [`<g${attrs({ 'data-subject': it.id, 'data-view': it.view })}>`];
  const sil = it.parts.filter((p) => p.silhouette).map((p) => polyPath(p.pts));
  if (sil.length) g.push(el('path', { d: sil.join(''), fill: C.ink, stroke: C.ink, 'stroke-width': out, 'stroke-linejoin': 'round' }));
  it.parts.forEach((p, i) => {
    const fill = p.fill === 'none' ? 'none' : p.fill === 'hair' ? C.hair : C.paper;
    g.push(
      el('path', {
        d: polyPath(p.pts),
        fill,
        stroke: p.stroke ? C.inner : 'none',
        'stroke-width': p.stroke ? inner : null,
        'stroke-linejoin': p.stroke ? 'round' : null,
      }),
    );
    for (const l of it.lines) {
      if (l.after === i) g.push(el('path', { d: polyPath(l.pts, false), fill: 'none', stroke: C.inner, 'stroke-width': inner, 'stroke-linecap': 'round' }));
    }
  });
  g.push('</g>');
  return g.join('');
}

// ---------------------------------------------------------------------------
// overlay
// ---------------------------------------------------------------------------

function arrowHead(a: V2, b: V2, len: number, half: number): { head: V2[]; shaftEnd: V2 } | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return null;
  const ux = dx / l;
  const uy = dy / l;
  const hl = Math.min(len, l * 0.6);
  const hw = half * (hl / len);
  const base: V2 = [b[0] - ux * hl, b[1] - uy * hl];
  return {
    head: [b, [base[0] - uy * hw, base[1] + ux * hw], [base[0] + uy * hw, base[1] - ux * hw]],
    shaftEnd: [b[0] - ux * hl * 0.6, b[1] - uy * hl * 0.6],
  };
}

/** Arrow (shaft + filled head) with a white halo for legibility. */
function arrowSvg(pts: V2[], opts: { width: number; dash?: string; heads?: 'end' | 'both'; head?: number }): string {
  if (pts.length < 2) return '';
  const head = opts.head ?? 20;
  const endH = arrowHead(pts[pts.length - 2] as V2, pts[pts.length - 1] as V2, head, head * 0.5);
  const startH = opts.heads === 'both' ? arrowHead(pts[1] as V2, pts[0] as V2, head, head * 0.5) : null;
  const shaft = pts.slice();
  if (endH) shaft[shaft.length - 1] = endH.shaftEnd;
  if (startH) shaft[0] = startH.shaftEnd;
  const d = polyPath(shaft, false);
  const heads = [endH, startH].filter((h): h is NonNullable<typeof h> => !!h).map((h) => polyPath(h.head));
  const g: string[] = [];
  g.push(el('path', { d, fill: 'none', stroke: C.halo, 'stroke-width': opts.width + 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  for (const h of heads) g.push(el('path', { d: h, fill: C.halo, stroke: C.halo, 'stroke-width': 5, 'stroke-linejoin': 'round' }));
  g.push(
    el('path', {
      d,
      fill: 'none',
      stroke: C.ink,
      'stroke-width': opts.width,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-dasharray': opts.dash ?? null,
    }),
  );
  for (const h of heads) g.push(el('path', { d: h, fill: C.ink, stroke: C.ink, 'stroke-width': 1, 'stroke-linejoin': 'round' }));
  return g.join('');
}

/** Candidate [from, to] heights for an anchored arrow, best first. */
function arrowWorldHeights(spec: BoardSpec, a: BoardArrow & { mode: 'anchored' }): [number, number][] {
  const subj = (id: string | null) => spec.scene.subjects.find((s) => s.id === id);
  const nearest = (x: number, z: number) =>
    spec.scene.subjects.reduce<{ s: (typeof spec.scene.subjects)[number] | null; d: number }>(
      (best, s) => {
        const d = Math.hypot(s.x - x, s.z - z);
        return d < best.d ? { s, d } : best;
      },
      { s: null, d: 0.6 },
    ).s;
  const from = subj(a.subject_id);
  if (a.kind === 'eyeline') {
    const to = nearest(a.world_to.x, a.world_to.z);
    const eye = (s: typeof from) => (s ? (poseTopY(s.pose) - 0.075) * s.height_m : 1.55);
    return [[eye(from), eye(to ?? from)]];
  }
  const lateral = Math.abs(a.world_to.x - a.world_from.x) > Math.abs(a.world_to.z - a.world_from.z);
  const top = from ? poseTopY(from.pose) * from.height_m : 1.7;
  // lateral: through the hips; toward/away: hip height, raised toward the lens height if off-frame
  const ks = lateral ? [0.5, 0.65, 0.35] : [0.42, 0.6, 0.75, 0.3];
  return ks.map((k) => [k * top, k * top] as [number, number]);
}

/**
 * Project an anchored arrow; when its tip leaves the frame, shorten it along the
 * world segment so the head stays visible (e.g. a subject running at the lens).
 */
function anchoredArrowPx(b: ReturnType<typeof cameraBasis>, from: V3, to: V3, W: number, H: number): V2[] | null {
  const m = 0.03;
  const at = (t: number): V2 | null => {
    const p: V3 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
    const q = projectPoint(b, p);
    return q.visible ? [q.x, q.y] : null;
  };
  const inside = (q: V2 | null) => !!q && q[0] >= m && q[0] <= 1 - m && q[1] >= m && q[1] <= 1 - m;
  const start = at(0);
  if (!start) return null;
  let end = at(1);
  if (inside(start) && !inside(end)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inside(at(mid))) lo = mid;
      else hi = mid;
    }
    end = at(lo);
  }
  if (!end) {
    const seg = projectSegment(b, from, to);
    if (!seg) return null;
    return [[seg[0][0] * W, seg[0][1] * H], [seg[1][0] * W, seg[1][1] * H]];
  }
  return [[start[0] * W, start[1] * H], [end[0] * W, end[1] * H]];
}

function cameraMoveSvg(m: Movement | null, W: number, H: number): string {
  if (!m || m === 'static') return '';
  const g: string[] = [`<g${attrs({ 'data-camera-move': m })}>`];
  const w = 3.2;
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
        g.push(arrowSvg(m === 'push_in' ? [near, far] : [far, near], { width: w }));
      }
      break;
    }
    case 'pan':
      g.push(arrowSvg([[W * 0.38, 40], [W * 0.62, 40]], { width: w, heads: 'both' }));
      break;
    case 'tilt':
      g.push(arrowSvg([[W - 42, H * 0.3], [W - 42, H * 0.7]], { width: w, heads: 'both' }));
      break;
    case 'track': {
      const x0 = W * 0.36;
      const x1 = W * 0.64;
      const y0 = H - 36;
      const y1 = H - 22;
      const ties: V2[][] = [];
      for (let x = x0 + 14; x < x1 - 6; x += 30) ties.push([[x, y0 - 5], [x, y1 + 5]]);
      const rails: V2[][] = [
        [[x0, y0], [x1, y0]],
        [[x0, y1], [x1, y1]],
      ];
      g.push(el('path', { d: linesPath([...rails, ...ties]), fill: 'none', stroke: C.halo, 'stroke-width': 8, 'stroke-linecap': 'round' }));
      g.push(el('path', { d: linesPath(rails), fill: 'none', stroke: C.ink, 'stroke-width': 3 }));
      g.push(el('path', { d: linesPath(ties), fill: 'none', stroke: C.ink, 'stroke-width': 2 }));
      g.push(
        text(
          { x: W / 2, y: y0 - 14, 'font-family': FONT, 'font-size': 22, 'font-weight': 700, 'text-anchor': 'middle', fill: C.ink, stroke: C.halo, 'stroke-width': 5, 'paint-order': 'stroke', 'letter-spacing': 3 },
          ZH_BOARD.track,
        ),
      );
      break;
    }
    case 'crane': {
      g.push(arrowSvg([[46, H * 0.62], [46, H * 0.26]], { width: w, heads: 'both' }));
      g.push(el('path', { d: polyPath([[28, H * 0.7], [64, H * 0.7]], false), fill: 'none', stroke: C.ink, 'stroke-width': 3.5, 'stroke-linecap': 'round' }));
      g.push(el('path', { d: polyPath([[46, H * 0.7], [46, H * 0.62]], false), fill: 'none', stroke: C.ink, 'stroke-width': 3.5 }));
      break;
    }
    case 'handheld': {
      const pts: V2[] = [];
      const x0 = W - 260;
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        pts.push([x0 + 190 * t, 40 + 8 * Math.sin(t * Math.PI * 8)]);
      }
      g.push(el('path', { d: polyPath(pts, false), fill: 'none', stroke: C.halo, 'stroke-width': 8, 'stroke-linecap': 'round' }));
      g.push(el('path', { d: polyPath(pts, false), fill: 'none', stroke: C.ink, 'stroke-width': 3, 'stroke-linecap': 'round' }));
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
      ];
      g.push(el('path', { d: polyPath(body), fill: C.paper, stroke: C.halo, 'stroke-width': 8, 'stroke-linejoin': 'round' }));
      g.push(el('path', { d: polyPath(body), fill: C.paper, stroke: C.ink, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
      for (const cx of [x + 24, x + 80]) g.push(el('circle', { cx, cy: y, r: 9, fill: C.ink }));
      break;
    }
  }
  g.push('</g>');
  return g.join('');
}

function guidesSvg(spec: BoardSpec, W: number, H: number): string {
  const g: string[] = [];
  for (const guide of spec.frame.guides) {
    if (guide === 'thirds') {
      const l: V2[][] = [
        [[W / 3, 0], [W / 3, H]],
        [[(2 * W) / 3, 0], [(2 * W) / 3, H]],
        [[0, H / 3], [W, H / 3]],
        [[0, (2 * H) / 3], [W, (2 * H) / 3]],
      ];
      g.push(el('path', { d: linesPath(l), fill: 'none', stroke: C.guide, 'stroke-width': 1, 'stroke-dasharray': '4 7' }));
    } else {
      const half = (H * Number(guide)) / 2;
      if (half * 2 >= W) continue;
      const l: V2[][] = [
        [[W / 2 - half, 0], [W / 2 - half, H]],
        [[W / 2 + half, 0], [W / 2 + half, H]],
      ];
      g.push(el('path', { d: linesPath(l), fill: 'none', stroke: C.guide, 'stroke-width': 1.5, 'stroke-dasharray': '14 9', 'data-guide': guide }));
    }
  }
  return g.join('');
}

function badgeSvg(cx: number, cy: number, letter: string, r = 17): string {
  return (
    el('circle', { cx, cy, r, fill: C.paper, stroke: C.ink, 'stroke-width': 2.4 }) +
    text({ x: cx, y: cy + r * 0.38, 'font-family': FONT, 'font-size': r * 1.12, 'font-weight': 700, 'text-anchor': 'middle', fill: C.ink }, letter)
  );
}

function overlaySvg(spec: BoardSpec, scene: FrameScene): string {
  const { W, H } = scene;
  const b = scene.basis;
  const o = spec.overlay;
  const g: string[] = [`<g${attrs({ 'data-layer': 'overlay', transform: `translate(${num(o.offset.x * W)} ${num(o.offset.y * H)})` })}>`];
  g.push(guidesSvg(spec, W, H));
  for (const a of o.arrows) {
    let pts: V2[] | null = null;
    if (a.mode === 'anchored') {
      for (const [y0, y1] of arrowWorldHeights(spec, a)) {
        pts = anchoredArrowPx(b, [a.world_from.x, y0, a.world_from.z], [a.world_to.x, y1, a.world_to.z], W, H);
        const s0 = pts?.[0];
        if (s0 && s0[0] >= 0 && s0[0] <= W && s0[1] >= 0 && s0[1] <= H) break;
      }
    } else {
      pts = [[a.from.x * W, a.from.y * H], [a.to.x * W, a.to.y * H]];
    }
    if (!pts) continue;
    const len = Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]);
    if (len < 8 || len > W * 3) continue;
    g.push(`<g${attrs({ 'data-arrow': a.id, 'data-kind': a.kind })}>`);
    g.push(
      a.kind === 'eyeline'
        ? arrowSvg(pts, { width: 2.6, dash: '12 8', head: 18 })
        : arrowSvg(pts, { width: a.kind === 'camera_move' ? 3 : 5, head: 28 }),
    );
    g.push('</g>');
  }
  g.push(cameraMoveSvg(o.camera_move, W, H));
  // A/B badges above heads (kept inside the frame).
  for (const it of scene.items) {
    if (it.type !== 'subject' || !it.badge) continue;
    const r = 17;
    let cx: number;
    let cy: number;
    if (it.head && it.head[0] > -W && it.head[0] < 2 * W) {
      cx = it.head[0];
      cy = it.head[1] - r - 12;
    } else if (it.bbox) {
      cx = (it.bbox.x0 + it.bbox.x1) / 2;
      cy = it.bbox.y0 - r - 12;
    } else continue;
    if (it.bbox) {
      const vx0 = Math.max(it.bbox.x0, 0);
      const vx1 = Math.min(it.bbox.x1, W);
      if (vx1 > vx0) cx = clamp(cx, vx0 + r, vx1 - r);
    }
    cx = clamp(cx, r + 8, W - r - 8);
    cy = clamp(cy, r + 8, H - r - 8);
    g.push(`<g${attrs({ 'data-badge': it.id })}>${badgeSvg(cx, cy, it.badge, r)}</g>`);
  }
  for (const l of o.labels) {
    g.push(
      text(
        { x: l.x * W, y: l.y * H, 'font-family': FONT, 'font-size': 26, fill: C.ink, stroke: C.halo, 'stroke-width': 6, 'paint-order': 'stroke', 'data-label': l.id },
        l.text,
      ),
    );
  }
  g.push('</g>');
  return g.join('');
}

// ---------------------------------------------------------------------------
// topview
// ---------------------------------------------------------------------------

function niceStep(v: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 20, 50]) if (s >= v) return s;
  return 100;
}

function renderTopview(spec: BoardSpec, opts: RenderOptions): string {
  const { W, H } = frameSize(spec.frame.aspect);
  const overlay = opts.overlay !== false;
  const cam = spec.camera;
  const pad = 56;
  const topBand = overlay ? 34 : 0;
  // Bounds over the camera, people, non-shell props and arrows.
  const xs: number[] = [cam.x];
  const zs: number[] = [cam.z];
  const addPt = (x: number, z: number) => {
    xs.push(x);
    zs.push(z);
  };
  for (const s of spec.scene.subjects) {
    addPt(s.x - 0.6, s.z - 0.6);
    addPt(s.x + 0.6, s.z + 0.6);
  }
  const propCorners = (p: BoardSpec['scene']['props'][number]): V2[] => {
    const o = propWorldOrigin(p, cam);
    const psi = o.yaw * DEG;
    const c = Math.cos(psi);
    const s = Math.sin(psi);
    return (
      [
        [-p.w / 2, -p.d / 2],
        [p.w / 2, -p.d / 2],
        [p.w / 2, p.d / 2],
        [-p.w / 2, p.d / 2],
      ] as V2[]
    ).map(([lx, lz]) => [o.x + lx * c + lz * s, o.z - lx * s + lz * c] as V2);
  };
  for (const p of spec.scene.props) if (!isEnvProp(p)) for (const q of propCorners(p)) addPt(q[0], q[1]);
  for (const a of spec.overlay.arrows) {
    if (a.mode !== 'anchored') continue;
    addPt(a.world_from.x, a.world_from.z);
    addPt(a.world_to.x, a.world_to.z);
  }
  if (spec.scene.subjects.length === 0) addPt(cam.x, cam.z + 4);
  let x0 = Math.min(...xs) - 0.8;
  let x1 = Math.max(...xs) + 0.8;
  let z0 = Math.min(...zs) - 0.8;
  let z1 = Math.max(...zs) + 0.8;
  if (x1 - x0 < 4) {
    const c = (x0 + x1) / 2;
    x0 = c - 2;
    x1 = c + 2;
  }
  if (z1 - z0 < 3) z1 = z0 + 3;
  const availW = W - 2 * pad;
  const availH = H - 2 * pad - topBand;
  const scale = Math.min(availW / (x1 - x0), availH / (z1 - z0));
  const xc = (x0 + x1) / 2;
  const zc = (z0 + z1) / 2;
  const P = (x: number, z: number): V2 => [W / 2 + (x - xc) * scale, topBand + pad + availH / 2 - (z - zc) * scale];
  const clipId = specId(spec, 'topview');

  const out: string[] = [svgOpen(W, H, opts.width)];
  out.push(`<defs><clipPath${attrs({ id: clipId })}>${el('rect', { x: 0, y: 0, width: W, height: H })}</clipPath></defs>`);
  if (opts.background !== false) out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: C.paper }));
  out.push(`<g${attrs({ 'clip-path': `url(#${clipId})` })}>`);

  // Grid.
  const step = niceStep(Math.max(x1 - x0, z1 - z0) / 14);
  const wx0 = xc - W / 2 / scale;
  const wx1 = xc + W / 2 / scale;
  const wz0 = zc - H / scale;
  const wz1 = zc + H / scale;
  const grid: V2[][] = [];
  for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) grid.push([P(x, wz0), P(x, wz1)]);
  for (let z = Math.ceil(wz0 / step) * step; z <= wz1; z += step) grid.push([P(wx0, z), P(wx1, z)]);
  out.push(el('path', { d: linesPath(grid), fill: 'none', stroke: gray(228), 'stroke-width': 1 }));
  if (spec.scene.env === 'street') {
    const road: V2[][] = [-STREET.walkHalf, -STREET.roadHalf, STREET.roadHalf, STREET.walkHalf].map((x) => [P(x, wz0), P(x, wz1)]);
    out.push(el('path', { d: linesPath(road), fill: 'none', stroke: C.road, 'stroke-width': 1.4 }));
  }

  // Frustum: wedge by hFOV, or the ground footprint when looking steeply down.
  const reach = Math.max(z1 - cam.z, x1 - x0, 3) * 1.6;
  if (cam.pitch_deg < -55) {
    const corners = ([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as V2[])
      .map(([fx, fy]) => unprojectToPlane(cam, spec.frame.aspect, fx, fy, 0))
      .filter((p): p is V3 => !!p);
    if (corners.length === 4)
      out.push(el('path', { d: polyPath(corners.map((p) => P(p[0], p[2]))), fill: C.wedge, stroke: C.guide, 'stroke-width': 1.5, 'stroke-dasharray': '10 7' }));
  } else {
    const half = hFov(cam.focal_mm) / 2;
    const yaw = cam.yaw_deg * DEG;
    const ray = (a: number): V2 => P(cam.x + Math.sin(a) * reach, cam.z + Math.cos(a) * reach);
    const c0 = P(cam.x, cam.z);
    out.push(el('path', { d: polyPath([c0, ray(yaw - half), ray(yaw + half)]), fill: C.wedge, stroke: 'none' }));
    out.push(el('path', { d: polyPath([ray(yaw - half), c0, ray(yaw + half)], false), fill: 'none', stroke: C.guide, 'stroke-width': 1.5, 'stroke-dasharray': '10 7' }));
  }

  // Props (footprints).
  const labels: string[] = [];
  for (const p of spec.scene.props) {
    const env = isEnvProp(p);
    const q = propCorners(p).map((c) => P(c[0], c[1]));
    out.push(
      el('path', {
        d: polyPath(q),
        fill: env ? C.envFill : C.paper,
        stroke: env ? C.envLine : C.line,
        'stroke-width': env ? 1.2 : 2,
        'stroke-linejoin': 'round',
        'data-prop': p.id,
      }),
    );
    if (!env && overlay) {
      const o = propWorldOrigin(p, cam);
      const c = P(o.x, o.z);
      labels.push(text({ x: c[0], y: c[1] + 7, 'font-family': FONT, 'font-size': 18, 'text-anchor': 'middle', fill: gray(90) }, ZH_PROP_KIND[p.kind]));
    }
  }
  out.push(...labels);

  // Arrows.
  for (const a of spec.overlay.arrows) {
    const pts: V2[] =
      a.mode === 'anchored'
        ? [P(a.world_from.x, a.world_from.z), P(a.world_to.x, a.world_to.z)]
        : [];
    if (pts.length < 2) continue;
    out.push(a.kind === 'eyeline' ? arrowSvg(pts, { width: 2.2, dash: '10 7', head: 16 }) : arrowSvg(pts, { width: 4, head: 22 }));
  }

  // People: circle + facing wedge + badge.
  const r = clamp(0.24 * scale, 10, 30);
  for (const s of spec.scene.subjects) {
    const c = P(s.x, s.z);
    const Y = s.yaw_deg * DEG;
    const F: V2 = [Math.sin(Y), Math.cos(Y)]; // page space (z up the page)
    const N: V2 = [-F[1], F[0]];
    const wedge: V2[] = [
      [c[0] + F[0] * r * 1.75, c[1] + F[1] * r * 1.75],
      [c[0] + F[0] * r * 0.45 + N[0] * r * 0.8, c[1] + F[1] * r * 0.45 + N[1] * r * 0.8],
      [c[0] + F[0] * r * 0.45 - N[0] * r * 0.8, c[1] + F[1] * r * 0.45 - N[1] * r * 0.8],
    ];
    out.push(`<g${attrs({ 'data-subject': s.id })}>`);
    out.push(el('path', { d: polyPath(wedge), fill: C.ink, stroke: C.ink, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    out.push(el('circle', { cx: c[0], cy: c[1], r, fill: C.paper, stroke: C.ink, 'stroke-width': 2.4 }));
    if (overlay) {
      out.push(text({ x: c[0], y: c[1] + r * 0.4, 'font-family': FONT, 'font-size': r * 1.1, 'font-weight': 700, 'text-anchor': 'middle', fill: C.ink }, s.badge));
      out.push(text({ x: c[0] + r + 8, y: c[1] - r * 0.6, 'font-family': FONT, 'font-size': 18, fill: gray(70) }, s.label));
    }
    out.push('</g>');
  }

  // Camera icon.
  {
    const c = P(cam.x, cam.z);
    const yaw = cam.yaw_deg * DEG;
    const F: V2 = [Math.sin(yaw), -Math.cos(yaw)];
    const N: V2 = [-F[1], F[0]];
    const at = (f: number, n: number): V2 => [c[0] + F[0] * f + N[0] * n, c[1] + F[1] * f + N[1] * n];
    const body = [at(-30, -15), at(-30, 15), at(-2, 15), at(-2, -15)];
    const lens = [at(-2, -8), at(-2, 8), at(16, 13), at(16, -13)];
    out.push('<g data-camera="1">');
    out.push(el('path', { d: polyPath(body), fill: C.ink, stroke: C.ink, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    out.push(el('path', { d: polyPath(lens), fill: C.paper, stroke: C.ink, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
    if (overlay) {
      out.push(
        text(
          { x: c[0] + 26, y: Math.min(c[1] + 30, H - 10), 'font-family': FONT, 'font-size': 18, fill: gray(60) },
          `${ZH_BOARD.camera} ${Math.round(cam.focal_mm)}mm · ${num(cam.y)}m`,
        ),
      );
    }
    out.push('</g>');
  }
  out.push('</g>');

  if (overlay) {
    // Scale bar + disclaimer.
    const barPx = step * scale;
    const bx = W - pad - barPx;
    const by = H - 24;
    out.push(el('path', { d: polyPath([[bx, by - 7], [bx, by], [bx + barPx, by], [bx + barPx, by - 7]], false), fill: 'none', stroke: C.ink, 'stroke-width': 2 }));
    out.push(text({ x: bx + barPx / 2, y: by - 12, 'font-family': FONT, 'font-size': 18, 'text-anchor': 'middle', fill: C.ink }, `${num(step)} m`));
    out.push(text({ x: 18, y: 32, 'font-family': FONT, 'font-size': 22, fill: gray(60) }, ZH_BOARD.topviewNote));
  }
  out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: 'none', stroke: C.ink, 'stroke-width': 3 }));
  out.push('</svg>');
  return out.join('');
}

/** Frame-px bbox of each subject's silhouette (null when fully behind the camera). */
export function subjectFrameBoxes(spec: BoardSpec): Map<string, { x0: number; y0: number; x1: number; y1: number; W: number; H: number } | null> {
  const scene = buildFrameScene(spec);
  const out = new Map<string, { x0: number; y0: number; x1: number; y1: number; W: number; H: number } | null>();
  for (const s of spec.scene.subjects) out.set(s.id, null);
  for (const it of scene.items) if (it.type === 'subject' && it.bbox) out.set(it.id, { ...it.bbox, W: scene.W, H: scene.H });
  return out;
}

/** Projected feet / head-top positions in frame units (0..1). */
export function subjectFramePoints(spec: BoardSpec): Map<string, { foot: V2 | null; head: V2 | null }> {
  const b = cameraBasis(spec.camera, spec.frame.aspect);
  const out = new Map<string, { foot: V2 | null; head: V2 | null }>();
  for (const s of spec.scene.subjects) {
    const top = poseTopY(s.pose) * s.height_m;
    const f = projectSegment(b, [s.x, 0, s.z], [s.x, 0.001, s.z]);
    const h = projectSegment(b, [s.x, top, s.z], [s.x, top + 0.001, s.z]);
    out.set(s.id, { foot: f ? f[0] : null, head: h ? h[0] : null });
  }
  return out;
}

/**
 * Standalone puppet preview (gallery / pickers): one figure standing on a
 * ground line, drawn with the same passes as the structure renderer.
 */
export function renderPuppetPreview(
  pose: Pose,
  view: PuppetView,
  mirror: boolean,
  silhouette: Silhouette,
  opts: { width?: number; height?: number; background?: boolean } = {},
): string {
  const W = opts.width ?? 120;
  const H = opts.height ?? 220;
  const figure = H * 0.84;
  const x0 = W / 2;
  const y0 = H - H * 0.06;
  const shape = buildPuppet(pose, view, mirror, silhouette);
  const px = (q: V2): V2 => [x0 + q[0] * figure, y0 - q[1] * figure];
  const idx = shape.lineAfter;
  const item: SubjectItem = {
    type: 'subject',
    id: `${pose}-${view}-${mirror ? 'm' : 'n'}-${silhouette}`,
    badge: '',
    label: '',
    depth: 1,
    order: 0,
    view,
    mirror,
    parts: shape.parts.map((p) => ({ pts: p.pts.map(px), fill: p.fill, stroke: p.stroke, silhouette: p.silhouette })),
    lines: shape.lines.map((l, i) => ({ pts: l.pts.map(px), after: idx[i] ?? shape.parts.length - 1 })),
    heightPx: figure,
    bbox: null,
    head: null,
    foot: null,
  };
  const out: string[] = [svgOpen(W, H, W)];
  if (opts.background !== false) out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: C.paper }));
  out.push(el('path', { d: polyPath([[W * 0.12, y0], [W * 0.88, y0]], false), fill: 'none', stroke: C.grid, 'stroke-width': 1.5 }));
  out.push(subjectSvg(item));
  out.push('</svg>');
  return out.join('');
}
