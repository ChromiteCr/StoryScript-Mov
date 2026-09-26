import { describe, expect, it } from 'vitest';
import type { Plan, Resource, ScheduleBlock, Setup, Shot, ShotFields } from '@storyscript/contracts';
import { localToUtc, parseCsv } from '@storyscript/core';
import {
  TAKE_LOG_COLUMNS,
  buildLookup,
  callSheetCsv,
  callSheetRows,
  isIdle,
  localTime,
  sceneNumber,
  shotNumber,
  shotsInShootingOrder,
  slateCards,
  slateCodeBlankTake,
  takeLogCsv,
} from '../src/lib/print-plan.ts';

const TZ = 'Asia/Shanghai';
const DAY = '2026-10-05';
const L = (t: string, off = 0) => localToUtc(DAY, t, TZ, off);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const fields = (action: string): ShotFields => ({
  template: null,
  shot_size: 'MS',
  angle: 'eye',
  lens: 'normal',
  focal_mm: null,
  movement: 'static',
  subjects: [],
  props: [],
  env: null,
  subject_motion: 'none',
  set_piece: false,
  pov_owner: null,
  frame_format: null,
  technique_id: null,
  est_seconds: 5,
  narrative_purpose: '',
  action,
  dialogue_quote: null,
  source: { paragraph_id: 'p-001', quote: '' },
  assumptions: [],
  questions: [],
});

const SCENE1 = id(900);
const SCENE2 = id(901);
const shot = (n: number, scene: string, code: string, setup: string, narrative: number): Shot => ({
  id: id(n),
  scene_id: scene,
  code,
  narrative_pos: narrative,
  source_anchor: null,
  manual_note: null,
  origin: 'manual',
  fields: fields(`动作 ${code}`),
  locked: false,
  archived: false,
  required_status: 'required',
  requirement_reason: null,
  setup_id: setup,
  needs_relink: false,
  content_hash: 'h',
  revision: 0,
  created_at: L('08:00'),
  updated_at: L('08:00'),
});

const A = id(100);
const B = id(101);
const PERF = id(200);
const LOC = id(201);
const setups: Setup[] = [
  { id: A, location_resource_id: LOC, label: '=场1 · 平视', shot_ids: [id(1), id(2)], resource_ids: [], durations: { setup_min: 30, per_shot_min: 15, reset_min: 10 }, estimate_confirmed: true },
  { id: B, location_resource_id: LOC, label: '场2 · 仰拍', shot_ids: [id(3)], resource_ids: [], durations: { setup_min: 0, per_shot_min: 60, reset_min: 0 }, estimate_confirmed: true },
];
const shots = [shot(1, SCENE1, '001', A, 1), shot(2, SCENE1, '002', A, 2), shot(3, SCENE2, '001', B, 1)];
const resources: Resource[] = [
  { id: PERF, type: 'performer', name: '演员甲', windows: [], cast_character_ids: [], confirmed: true },
  { id: LOC, type: 'location', name: '书店', windows: [], cast_character_ids: [], confirmed: true },
];

const block = (bid: string, kind: ScheduleBlock['kind'], setup: string, start: string, end: string, shotIds: string[], res: string[]): ScheduleBlock => ({
  id: bid,
  kind,
  setup_id: setup,
  shot_ids: shotIds,
  resource_ids: res,
  start_utc: start,
  end_utc: end,
  locked: false,
});

// B shoots first (09:00–10:00), a 30 min gap, then A (setup 10:30, shoot 11:00–11:30, reset 11:30–11:40)
const plan: Plan = {
  id: id(500),
  date: DAY,
  timezone: TZ,
  day_start_utc: L('08:00'),
  result: {
    outcome: 'feasible',
    order: [B, A],
    blocks: [
      block('A-setup', 'setup', A, L('10:30'), L('11:00'), [], [LOC]),
      block('A-shoot', 'shoot', A, L('11:00'), L('11:30'), [id(1), id(2)], [LOC, PERF]),
      block('A-reset', 'reset', A, L('11:30'), L('11:40'), [], [LOC]),
      block('B-shoot', 'shoot', B, L('09:00'), L('10:00'), [id(3)], [LOC]),
    ],
    unplaced: [],
    contradictions: [],
    violations: [],
    algorithm_version: 'x',
    validator_version: 'y',
  },
  input_hash: 'h',
  status: 'draft',
  revision: 0,
  created_at: L('08:00'),
  updated_at: L('08:00'),
};

const lookup = buildLookup({
  timezone: TZ,
  date: DAY,
  setups,
  shots,
  resources,
  scenes: [
    { id: SCENE1, display_no: '1' },
    { id: SCENE2, display_no: '2' },
  ],
});

describe('local time on the plan date', () => {
  it('marks times after midnight as next day', () => {
    expect(localTime(L('09:05'), TZ, DAY)).toBe('09:05');
    expect(localTime(L('01:30', 1), TZ, DAY)).toBe('次日 01:30');
    expect(localTime(L('23:00', -1), TZ, DAY)).toBe('10-04 23:00');
  });
});

describe('call sheet', () => {
  it('lists blocks in time order with idle gaps; performers only on shoot rows', () => {
    const rows = callSheetRows(plan, lookup);
    expect(rows.map((r) => (isIdle(r) ? `idle ${r.start}-${r.end} ${r.minutes}` : `${r.kind_label} ${r.start}-${r.end}`))).toEqual([
      '拍摄 09:00-10:00',
      'idle 10:00-10:30 30',
      '准备 10:30-11:00',
      '拍摄 11:00-11:30',
      '复位 11:30-11:40',
    ]);
    const shootA = rows[3]!;
    expect(isIdle(shootA)).toBe(false);
    if (!isIdle(shootA)) {
      expect(shootA.shots).toBe('1-001、1-002');
      expect(shootA.performers).toBe('演员甲');
      expect(shootA.location).toBe('书店');
      expect(shootA.minutes).toBe(30);
    }
    const setupA = rows[2]!;
    if (!isIdle(setupA)) expect(setupA.performers).toBe('');
  });

  it('CSV: optional BOM, Chinese headers, no idle rows, formula cells neutralised', () => {
    const withBom = callSheetCsv(plan, lookup, true);
    expect(withBom.startsWith('﻿')).toBe(true);
    const plain = callSheetCsv(plan, lookup, false);
    expect(plain.startsWith('﻿')).toBe(false);
    const rows = parseCsv(plain);
    expect(rows[0]).toEqual(['开始', '结束', '分钟', '类型', 'setup', '镜头', '演员', '场地', '设备']);
    expect(rows).toHaveLength(5); // header + 4 blocks
    expect(rows[2]![4]).toBe("'=场1 · 平视"); // label starting with "=" becomes text
    expect(rows[1]!.slice(0, 4)).toEqual(['09:00', '10:00', '60', '拍摄']);
  });
});

describe('slate cards and take log', () => {
  it('reads scene and shot numbers leniently', () => {
    expect(sceneNumber('12A')).toBe(12);
    expect(sceneNumber('第三场')).toBeNull();
    expect(shotNumber('003')).toBe(3);
    expect(shotNumber('A12')).toBe(12);
    expect(shotNumber('插入')).toBeNull();
  });

  it('formats the slate code with a blank take', () => {
    expect(slateCodeBlankTake('S{scene:02}-{shot:03}-T{take:02}', 1, 3)).toBe('S01-003-T__');
    expect(slateCodeBlankTake('{scene}/{shot}', 12, 7)).toBe('12/7');
    expect(slateCodeBlankTake('S{scene:02}-{shot:03}-T{take:03}', 2, 11)).toBe('S02-011-T___');
    expect(slateCodeBlankTake('{bogus}', 1, 1)).toBeNull();
    expect(slateCodeBlankTake('S{scene:02}-{shot:03}', null, 1)).toBeNull();
  });

  it('one card per planned shot in shooting order', () => {
    expect(shotsInShootingOrder(plan)).toEqual([id(3), id(1), id(2)]);
    const cards = slateCards(plan, lookup, 'S{scene:02}-{shot:03}-T{take:02}');
    expect(cards.map((c) => [c.scene, c.shot, c.code])).toEqual([
      ['2', '001', 'S02-001-T__'],
      ['1', '001', 'S01-001-T__'],
      ['1', '002', 'S01-002-T__'],
    ]);
    expect(cards[0]!.setup).toBe('场2 · 仰拍');
  });

  it('take log template: fixed columns, scene/shot prefilled, everything else blank', () => {
    const csv = takeLogCsv(plan, lookup, false);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...TAKE_LOG_COLUMNS]);
    expect(rows[0]).toEqual(['scene', 'shot', 'take', 'camera', 'roll', 'clip', 'good', 'rating', 'tc_in', 'logged_at', 'notes']);
    expect(rows.slice(1)).toEqual([
      ['2', '001', '', '', '', '', '', '', '', '', ''],
      ['1', '001', '', '', '', '', '', '', '', '', ''],
      ['1', '002', '', '', '', '', '', '', '', '', ''],
    ]);
    expect(takeLogCsv(plan, lookup, true).startsWith('﻿')).toBe(true);
  });
});
