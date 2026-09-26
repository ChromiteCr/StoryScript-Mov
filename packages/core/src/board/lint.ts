/**
 * Board sanity checks. Pure; messages are display strings (zh), codes are stable.
 */
import type { BoardSpec, ScreenSides, ShotFields } from '@storyscript/contracts';
import { ZH_BOARD } from '../i18n/zh.ts';
import { inferTemplate } from './layout.ts';
import { subjectFrameBoxes } from './render.ts';

export type BoardLintLevel = 'error' | 'warning';

export interface BoardLintIssue {
  level: BoardLintLevel;
  code:
    | 'subject_count'
    | 'ots_fg_missing'
    | 'ots_fg_not_cropped'
    | 'axis_cross'
    | 'badge_duplicate'
    | 'badge_empty'
    | 'subject_offscreen'
    | 'needs_manual_layout';
  message: string;
  subject_id: string | null;
}

export interface LintOptions {
  scene_sides?: ScreenSides | null;
}

/**
 * lintBoard(spec, shot): subject count, OTS foreground crop, 180° axis
 * (needs scene_sides), unique badges, and "needs manual layout" for complex shots.
 * Subjects map to shot.subjects by index (board subject id `s<i>`).
 */
export function lintBoard(spec: BoardSpec, shot: ShotFields, opts: LintOptions = {}): BoardLintIssue[] {
  const L = ZH_BOARD.lint;
  const issues: BoardLintIssue[] = [];
  const subjects = spec.scene.subjects;
  const template = shot.template ?? inferTemplate(shot);

  if (subjects.length !== shot.subjects.length) {
    issues.push({ level: 'warning', code: 'subject_count', message: L.subject_count(subjects.length, shot.subjects.length), subject_id: null });
  }

  // Badges: present and unique.
  const seen = new Map<string, string>();
  for (const s of subjects) {
    const b = s.badge.trim();
    if (!b) {
      issues.push({ level: 'error', code: 'badge_empty', message: L.badge_empty(s.label), subject_id: s.id });
      continue;
    }
    if (seen.has(b)) issues.push({ level: 'error', code: 'badge_duplicate', message: L.badge_duplicate(b), subject_id: s.id });
    else seen.set(b, s.id);
  }

  const boxes = subjectFrameBoxes(spec);
  const aliasOf = (id: string) => {
    const m = /^s(\d+)$/.exec(id);
    return m ? (shot.subjects[Number(m[1])]?.alias ?? null) : null;
  };

  // OTS: the foreground (pov owner) must be cut by a frame edge.
  let fgId: string | null = null;
  if (template === 'ots' && subjects.length >= 2) {
    const povIdx = shot.pov_owner ? shot.subjects.findIndex((s) => s.alias === shot.pov_owner) : -1;
    const fg = subjects.find((s) => s.id === `s${povIdx >= 0 ? povIdx : 0}`);
    if (!fg) {
      issues.push({ level: 'warning', code: 'ots_fg_missing', message: L.ots_fg_missing, subject_id: null });
    } else {
      fgId = fg.id;
      const bb = boxes.get(fg.id);
      const cropped = !!bb && (bb.x0 < 0 || bb.x1 > bb.W);
      if (!cropped) issues.push({ level: 'warning', code: 'ots_fg_not_cropped', message: L.ots_fg_not_cropped(fg.label), subject_id: fg.id });
    }
  }

  // Off-screen people (insert shots keep people off frame on purpose).
  if (template !== 'insert') {
    for (const s of subjects) {
      if (s.id === fgId) continue;
      const bb = boxes.get(s.id);
      const off = !bb || bb.x1 < 0 || bb.x0 > bb.W || bb.y1 < 0 || bb.y0 > bb.H;
      if (off) issues.push({ level: 'warning', code: 'subject_offscreen', message: L.subject_offscreen(s.label), subject_id: s.id });
    }
  }

  // 180° axis: scene_sides.left must stay screen-left of scene_sides.right.
  const sides = opts.scene_sides;
  if (sides?.left && sides.right) {
    const find = (alias: string) => subjects.find((s) => aliasOf(s.id) === alias);
    const a = find(sides.left);
    const b = find(sides.right);
    const ba = a ? boxes.get(a.id) : null;
    const bb = b ? boxes.get(b.id) : null;
    if (a && b && ba && bb) {
      const ca = (ba.x0 + ba.x1) / 2;
      const cb = (bb.x0 + bb.x1) / 2;
      if (ca > cb) issues.push({ level: 'warning', code: 'axis_cross', message: L.axis_cross(a.label, b.label), subject_id: a.id });
    }
  }

  // Complex shots that templates only approximate.
  const why: string[] = [];
  if (shot.subjects.length >= 4) why.push(L.why_many_subjects(shot.subjects.length));
  if (template === 'ots' && shot.subjects.length !== 2) why.push(L.why_ots_count(shot.subjects.length));
  if (template === 'insert' && shot.subjects.length > 0) why.push(L.why_insert_subjects);
  if (template === 'lateral_move' && shot.subjects.length >= 3) why.push(L.why_motion_crowd(shot.subjects.length));
  if (why.length) issues.push({ level: 'warning', code: 'needs_manual_layout', message: L.needs_manual_layout(why.join('；')), subject_id: null });

  return issues;
}
