import { describe, expect, test } from 'vitest';
import { BreakdownOutput, type ShotFields } from '@storyscript/contracts';
import { normalizeBreakdownJson } from '../../src/index.ts';

/** S4c: clear synonyms of the new poses, props and places; anything else still fails zod. */

const base: ShotFields = {
  template: 'single',
  shot_size: 'MS',
  angle: 'eye',
  lens: 'normal',
  focal_mm: null,
  movement: 'static',
  subjects: [{ alias: 'c1', screen: 'L', depth: 'mg', facing: '3q_right', pose: 'stand' }],
  props: [],
  env: 'interior',
  subject_motion: 'none',
  set_piece: false,
  pov_owner: null,
  frame_format: null,
  technique_id: null,
  est_seconds: 4,
  narrative_purpose: '林川在宿舍',
  action: '林川躺在床上看手机',
  dialogue_quote: null,
  source: { paragraph_id: 'p-002', quote: '林川躺在床上看手机。' },
  assumptions: [],
  questions: [],
};

const one = (over: Record<string, unknown>) => normalizeBreakdownJson({ shots: [{ ...base, ...over }] }) as { shots: Record<string, unknown>[] };
const pose = (p: string) => (one({ subjects: [{ ...base.subjects[0], pose: p }] }).shots[0]!.subjects as { pose: unknown }[])[0]!.pose;
const props = (p: string[]) => one({ props: p }).shots[0]!.props;
const env = (e: string) => one({ env: e }).shots[0]!.env;

describe('S4c synonyms', () => {
  test('poses', () => {
    for (const p of ['lying', 'Lying down', '躺', '躺着', 'lie']) expect(pose(p), p).toBe('lie');
    for (const p of ['kneeling', 'on one knee', '跪', 'Kneel']) expect(pose(p), p).toBe('kneel');
    for (const p of ['reaching', 'reach out', '伸手']) expect(pose(p), p).toBe('reach');
    for (const p of ['on the phone', 'phoning', '打电话', 'PHONE']) expect(pose(p), p).toBe('phone');
  });

  test('props', () => {
    expect(props(['Beds', 'couch', 'bookshelf', 'desk lamp', 'trees'])).toEqual(['bed', 'sofa', 'shelf', 'lamp', 'tree']);
    expect(props(['mobile', 'cellphone', 'Smartphone', '手机'])).toEqual(['phone', 'phone', 'phone', 'phone']);
    expect(props(['mug', '杯子', 'books', 'backpack'])).toEqual(['cup', 'cup', 'book', 'bag']);
    expect(props(['书架', '沙发', '书包'])).toEqual(['shelf', 'sofa', 'bag']);
  });

  test('places', () => {
    for (const e of ['forest', 'woods', 'Woodland', '树林', '野外']) expect(env(e), e).toBe('nature');
    for (const e of ['hallway', 'Hall-way', '走廊', '楼道']) expect(env(e), e).toBe('corridor');
    for (const e of ['class room', '教室', 'Classroom']) expect(env(e), e).toBe('classroom');
  });

  test('a normalised shot with the new values passes zod', () => {
    const out = BreakdownOutput.parse(one({ subjects: [{ ...base.subjects[0], pose: '躺' }], props: ['bed', 'mobile phone'], env: 'hallway' }));
    expect(out.shots[0]).toMatchObject({ subjects: [{ pose: 'lie' }], props: ['bed', 'phone'], env: 'corridor' });
  });

  test('no semantic guessing: near misses stay as they are and fail zod', () => {
    const out = one({ subjects: [{ ...base.subjects[0], pose: 'sleeping' }], props: ['laptop', 'light', 'notebook'], env: 'park' });
    expect(pose('sleeping')).toBe('sleeping');
    expect(props(['laptop', 'light', 'notebook'])).toEqual(['laptop', 'light', 'notebook']);
    expect(env('park')).toBe('park');
    const r = BreakdownOutput.safeParse(out);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['shots.0.subjects.0.pose', 'shots.0.props.0', 'shots.0.props.1', 'shots.0.props.2', 'shots.0.env']),
    );
  });
});
