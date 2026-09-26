import { describe, expect, test } from 'vitest';
import {
  layoutBoard,
  lintBoard,
  shotFields,
  STANDARD_LOOK,
  STANDARD_ROSTER,
  STANDARD_SHOTS,
  STANDARD_SIDES,
  standardBoard,
  standardSubject as subject,
} from '../../src/index.ts';

const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe('lintBoard', () => {
  test('standard shots are clean apart from the flagged crowd scene', () => {
    for (const shot of STANDARD_SHOTS) {
      const issues = lintBoard(standardBoard(shot), shot.fields, { scene_sides: shot.scene_sides });
      if (shot.key === '12-group') expect(codes(issues)).toEqual(['needs_manual_layout']);
      else expect(issues, shot.key).toEqual([]);
    }
  });

  test('subject count mismatch', () => {
    const shot = STANDARD_SHOTS[4]!;
    const spec = standardBoard(shot);
    const issues = lintBoard({ ...spec, scene: { ...spec.scene, subjects: [] } }, shot.fields);
    expect(codes(issues)).toContain('subject_count');
  });

  test('ots foreground must be cut by the frame', () => {
    const shot = STANDARD_SHOTS.find((s) => s.key === '03-ots-a')!;
    const spec = standardBoard(shot);
    const moved = { ...spec, scene: { ...spec.scene, subjects: spec.scene.subjects.map((s) => (s.id === 's0' ? { ...s, x: 0, z: s.z * 3 } : s)) } };
    const issues = lintBoard(moved, shot.fields, { scene_sides: STANDARD_SIDES });
    expect(codes(issues)).toContain('ots_fg_not_cropped');
  });

  test('crossing the 180° line is reported', () => {
    const f = shotFields({ shot_size: 'MS', subjects: [subject('c1'), subject('c2')] });
    const spec = layoutBoard(f, { scene_sides: STANDARD_SIDES, roster: STANDARD_ROSTER, look: STANDARD_LOOK, aspect: '2.39', seed: 1 });
    expect(lintBoard(spec, f, { scene_sides: STANDARD_SIDES })).toEqual([]);
    const flipped = lintBoard(spec, f, { scene_sides: { left: 'c2', right: 'c1' } });
    expect(codes(flipped)).toEqual(['axis_cross']);
    expect(flipped[0]!.message).toContain('越轴');
  });

  test('badges must be present and unique', () => {
    const shot = STANDARD_SHOTS[11]!;
    const spec = standardBoard(shot);
    const dup = { ...spec, scene: { ...spec.scene, subjects: spec.scene.subjects.map((s, i) => ({ ...s, badge: i < 2 ? 'A' : i === 3 ? ' ' : s.badge })) } };
    const issues = lintBoard(dup, shot.fields);
    expect(issues.filter((i) => i.level === 'error').map((i) => i.code).sort()).toEqual(['badge_duplicate', 'badge_empty']);
  });

  test('complex shots ask for manual layout', () => {
    const f = shotFields({ shot_size: 'INSERT', subjects: [subject('c1')], props: ['box'] });
    const spec = layoutBoard(f, { scene_sides: null, roster: STANDARD_ROSTER, look: STANDARD_LOOK, aspect: '2.39', seed: 1 });
    const issues = lintBoard(spec, f);
    expect(codes(issues)).toEqual(['needs_manual_layout']);
    expect(issues[0]!.message).toContain('需人工布局');
  });

  test('off-screen people are reported', () => {
    const shot = STANDARD_SHOTS[4]!;
    const spec = standardBoard(shot);
    const off = { ...spec, scene: { ...spec.scene, subjects: spec.scene.subjects.map((s) => ({ ...s, x: s.x + 40 })) } };
    expect(codes(lintBoard(off, shot.fields))).toContain('subject_offscreen');
  });
});
