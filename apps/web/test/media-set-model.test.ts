import { describe, expect, it } from 'vitest';
import type { Plan, Scene, Setup, Shot, Take } from '@storyscript/contracts';
import { ratingForKey, RATING_KEYS, RATING_LABEL } from '../src/lib/labels-media.ts';
import {
  buildShotRefs,
  nextClipHint,
  nextTakeNo,
  parseLabels,
  pickApprovedPlan,
  setupOfShot,
  shootingOrder,
  slateCode,
  takesForShot,
} from '../src/views/set/model.ts';

/** Set page logic (FR-07): order, numbering, slate preview, keyboard ratings. Pure. */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scenes: Pick<Scene, 'id' | 'display_no' | 'heading'>[] = [
  { id: id(901), display_no: '1', heading: '内景 书店 日' },
  { id: id(902), display_no: '2', heading: '外景 街道 夜' },
];

function shot(n: number, scene: number, code: string, pos: number, extra: Partial<Shot> = {}): Shot {
  return {
    id: id(n),
    scene_id: id(900 + scene),
    code,
    narrative_pos: pos,
    source_anchor: null,
    manual_note: null,
    origin: 'manual',
    fields: {} as Shot['fields'],
    locked: false,
    archived: false,
    required_status: 'required',
    requirement_reason: null,
    setup_id: null,
    needs_relink: false,
    content_hash: 'h',
    revision: 0,
    created_at: '2026-09-26T00:00:00.000Z',
    updated_at: '2026-09-26T00:00:00.000Z',
    ...extra,
  };
}

// deliberately out of order; one archived
const shots = [shot(3, 2, '001', 1), shot(2, 1, '002', 2), shot(1, 1, '001', 1), shot(4, 1, '003', 3, { archived: true })];

describe('shot refs and shooting order', () => {
  const refs = buildShotRefs(shots, scenes);

  it('labels scene-shot and sorts by scene, then narrative position; archived shots drop out', () => {
    expect(refs.map((r) => r.label)).toEqual(['1-001', '1-002', '2-001']);
  });

  it('without an approved plan: narrative order grouped by scene', () => {
    const o = shootingOrder(refs, [], []);
    expect(o.source).toBe('narrative');
    expect(o.groups.map((g) => [g.title, g.refs.map((r) => r.label)])).toEqual([
      ['第 1 场', ['1-001', '1-002']],
      ['第 2 场', ['2-001']],
    ]);
  });

  const setups: Setup[] = [
    { id: id(801), location_resource_id: null, label: '街道 · 正打', shot_ids: [id(3)], resource_ids: [], durations: { setup_min: 1, per_shot_min: 1, reset_min: 0 }, estimate_confirmed: true },
    { id: id(802), location_resource_id: null, label: '书店 · 反打', shot_ids: [id(2)], resource_ids: [], durations: { setup_min: 1, per_shot_min: 1, reset_min: 0 }, estimate_confirmed: true },
  ];
  const plan = (status: Plan['status'], date: string, updated: string): Plan => ({
    id: id(700 + Number(date.slice(-2))),
    date,
    timezone: 'Asia/Shanghai',
    day_start_utc: '2026-09-26T00:00:00.000Z',
    result: {
      outcome: 'feasible',
      order: [id(801), id(802)],
      blocks: [],
      unplaced: [],
      contradictions: [],
      violations: [],
      algorithm_version: 'x',
      validator_version: 'x',
    },
    input_hash: 'h',
    status,
    revision: 0,
    created_at: updated,
    updated_at: updated,
  });

  it('with an approved plan: setup order first, unplanned shots last; drafts are ignored', () => {
    const o = shootingOrder(refs, [plan('draft', '2026-09-27', '2026-09-26T09:00:00.000Z'), plan('approved', '2026-09-26', '2026-09-26T08:00:00.000Z')], setups);
    expect(o.source).toBe('plan');
    expect(o.refs.map((r) => r.label)).toEqual(['2-001', '1-002', '1-001']);
    expect(o.groups.map((g) => g.title)).toEqual(['街道 · 正打', '书店 · 反打', '计划外']);
    expect(setupOfShot(setups, id(2))).toBe(id(802));
    expect(setupOfShot(setups, id(1))).toBeNull();
  });

  it("prefers today's approved plan, else the latest approved one", () => {
    const a = plan('approved', '2026-09-25', '2026-09-26T10:00:00.000Z');
    const b = plan('approved', '2026-09-26', '2026-09-26T08:00:00.000Z');
    expect(pickApprovedPlan([a, b], '2026-09-26')).toBe(b);
    expect(pickApprovedPlan([a, b], '2026-10-01')).toBe(a);
    expect(pickApprovedPlan([plan('draft', '2026-09-26', '2026-09-26T08:00:00.000Z')])).toBeNull();
  });
});

describe('take numbers and slate codes', () => {
  const takes: Pick<Take, 'shot_ids' | 'take_no' | 'logged_at'>[] = [
    { shot_ids: [id(1)], take_no: 1, logged_at: '2026-09-26T01:00:00.000Z' },
    { shot_ids: [id(1)], take_no: 2, logged_at: '2026-09-26T01:05:00.000Z' },
    { shot_ids: [id(2), id(1)], take_no: 1, logged_at: '2026-09-26T01:10:00.000Z' },
  ];

  it('counts per exact shot set, order-insensitive (same rule as the server)', () => {
    expect(nextTakeNo(takes, [id(1)])).toBe(3);
    expect(nextTakeNo(takes, [id(1), id(2)])).toBe(2);
    expect(nextTakeNo(takes, [id(3)])).toBe(1);
  });

  it('lists a shot’s takes newest number first, including multi-shot takes', () => {
    expect(takesForShot(takes, id(1)).map((t) => t.take_no)).toEqual([2, 1, 1]);
    expect(takesForShot(takes, id(2))).toHaveLength(1);
  });

  it('formats the slate from the project code format; non-numeric codes give none', () => {
    expect(slateCode('S{scene:02}-{shot:03}-T{take:02}', '1', '003', 2)).toBe('S01-003-T02');
    expect(slateCode('S{scene:02}-{shot:03}-T{take:02}', '12', '7', 11)).toBe('S12-007-T11');
    expect(slateCode('S{scene:02}-{shot:03}-T{take:02}', '3A', '001', 1)).toBeNull();
    expect(slateCode('{bad}', '1', '001', 1)).toBeNull();
  });

  it('counts the camera clip name up, keeping the zero padding', () => {
    expect(nextClipHint('A001C003')).toBe('A001C004');
    expect(nextClipHint('IMG_0999')).toBe('IMG_1000');
    expect(nextClipHint('C0009.MP4')).toBe('C0010.MP4');
    expect(nextClipHint('  B002C099 ')).toBe('B002C100');
    expect(nextClipHint('无编号')).toBeNull();
    expect(nextClipHint(null)).toBeNull();
  });

  it('splits hand-written labels on , ， 、 ; ；', () => {
    expect(parseLabels('3A-2, 十二 ，3A-2、x；y;')).toEqual(['3A-2', '十二', 'x', 'y']);
    expect(parseLabels('   ')).toEqual([]);
  });
});

describe('rating keys', () => {
  it('maps 1 / 2 / 3 / 0 to good / alternate / reject / unrated', () => {
    expect(RATING_KEYS.map((k) => [k.key, RATING_LABEL[k.rating]])).toEqual([
      ['1', '好'],
      ['2', '备选'],
      ['3', '废'],
      ['0', '未评'],
    ]);
    expect(ratingForKey('1')).toBe('good');
    expect(ratingForKey('0')).toBe('unrated');
    expect(ratingForKey('4')).toBeNull();
    expect(ratingForKey('Enter')).toBeNull();
  });
});
