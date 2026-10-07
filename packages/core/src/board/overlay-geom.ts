/**
 * Annotation-layer geometry shared by the structure and pencil renderers:
 * both styles anchor arrows, badges and labels at exactly the same places
 * (only the drawing style differs). Pure.
 */
import type { BoardArrow, BoardSpec } from '@storyscript/contracts';
import { projectPoint, projectSegment, type CameraBasis } from './camera.ts';
import { clamp, type V2, type V3 } from './math.ts';
import { poseTopY } from './puppets.ts';
import type { FrameScene } from './scene.ts';

export const FONT = 'PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Microsoft YaHei, sans-serif';

/** Candidate [from, to] heights for an anchored arrow, best first. */
export function arrowWorldHeights(spec: BoardSpec, a: BoardArrow & { mode: 'anchored' }): [number, number][] {
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
export function anchoredArrowPx(b: CameraBasis, from: V3, to: V3, W: number, H: number): V2[] | null {
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

/** Where one overlay arrow is drawn: frame-px end points and, when anchored, the world heights used. */
export interface ArrowPlacement {
  pts: V2[];
  heights: [number, number] | null;
}

/**
 * Place one overlay arrow (null when it cannot be drawn). The renderers and
 * the web editor's drag handles both use this, so a handle sits exactly on
 * the drawn arrow.
 */
export function placeArrow(spec: BoardSpec, basis: CameraBasis, W: number, H: number, a: BoardArrow): ArrowPlacement | null {
  let pts: V2[] | null = null;
  let heights: [number, number] | null = null;
  if (a.mode === 'anchored') {
    for (const hh of arrowWorldHeights(spec, a)) {
      pts = anchoredArrowPx(basis, [a.world_from.x, hh[0], a.world_from.z], [a.world_to.x, hh[1], a.world_to.z], W, H);
      heights = hh;
      const s0 = pts?.[0];
      if (s0 && s0[0] >= 0 && s0[0] <= W && s0[1] >= 0 && s0[1] <= H) break;
    }
  } else {
    pts = [[a.from.x * W, a.from.y * H], [a.to.x * W, a.to.y * H]];
  }
  if (!pts) return null;
  const len = Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]);
  if (len < 8 || len > W * 3) return null;
  return { pts, heights };
}

/** Frame-px polyline of one overlay arrow (null when it cannot be drawn). */
export function arrowPx(spec: BoardSpec, scene: FrameScene, a: BoardArrow): V2[] | null {
  return placeArrow(spec, scene.basis, scene.W, scene.H, a)?.pts ?? null;
}

/** A/B badge centres above heads, kept inside the frame (null = not drawn). */
export function badgePlacement(scene: FrameScene, it: FrameScene['items'][number], r: number): V2 | null {
  const { W, H } = scene;
  if (it.type !== 'subject' || !it.badge) return null;
  let cx: number;
  let cy: number;
  if (it.head && it.head[0] > -W && it.head[0] < 2 * W) {
    cx = it.head[0];
    cy = it.head[1] - r - 12;
  } else if (it.bbox) {
    cx = (it.bbox.x0 + it.bbox.x1) / 2;
    cy = it.bbox.y0 - r - 12;
  } else return null;
  if (it.bbox) {
    const vx0 = Math.max(it.bbox.x0, 0);
    const vx1 = Math.min(it.bbox.x1, W);
    if (vx1 > vx0) cx = clamp(cx, vx0 + r, vx1 - r);
  }
  cx = clamp(cx, r + 8, W - r - 8);
  cy = clamp(cy, r + 8, H - r - 8);
  return [cx, cy];
}

/** Protection-guide lines (1.43 / 1.78 centre extraction, thirds) in frame px. */
export function guideLines(spec: BoardSpec, W: number, H: number): { guide: string; lines: V2[][] }[] {
  const out: { guide: string; lines: V2[][] }[] = [];
  for (const guide of spec.frame.guides) {
    if (guide === 'thirds') {
      out.push({
        guide,
        lines: [
          [[W / 3, 0], [W / 3, H]],
          [[(2 * W) / 3, 0], [(2 * W) / 3, H]],
          [[0, H / 3], [W, H / 3]],
          [[0, (2 * H) / 3], [W, (2 * H) / 3]],
        ],
      });
    } else {
      const half = (H * Number(guide)) / 2;
      if (half * 2 >= W) continue;
      out.push({
        guide,
        lines: [
          [[W / 2 - half, 0], [W / 2 - half, H]],
          [[W / 2 + half, 0], [W / 2 + half, H]],
        ],
      });
    }
  }
  return out;
}

/**
 * S5b callouts: where a label naming a prop points — the middle of the prop's
 * drawn faces, kept inside the frame (null when the prop is not drawn).
 */
export function propAnchor(scene: FrameScene, propId: string): V2 | null {
  const it = scene.items.find((i) => i.type === 'prop' && i.id === propId);
  if (!it || it.type !== 'prop') return null;
  const pts = it.faces.flatMap((f) => f.pts);
  if (!pts.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [clamp((x0 + x1) / 2, 0, scene.W), clamp((y0 + y1) / 2, 0, scene.H)];
}

/** The leader from a label's box (x, y, w, h) to its target: from the box edge nearest the target, stopping short of it. */
export function leaderLine(box: { x: number; y: number; w: number; h: number }, target: V2, gap = 6): [V2, V2] | null {
  const from: V2 = [clamp(target[0], box.x, box.x + box.w), clamp(target[1], box.y, box.y + box.h)];
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const l = Math.hypot(dx, dy);
  if (l < gap * 3) return null;
  return [from, [target[0] - (dx / l) * gap, target[1] - (dy / l) * gap]];
}
