import { ScheduleResult } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { localToUtc, localWindowToUtc, utcToLocal } from '../../src/schedule/time.ts';
import { schedule } from '../../src/schedule/schedule.ts';
import { validate } from '../../src/schedule/validate.ts';
import type { ScheduleInput } from '../../src/schedule/types.ts';
import { blockMinutes, insideSomeWindow, locked, ms, notBefore, overlappingPairs, resource, setup, shot, uid } from './fixtures.ts';

// AT-07: two performers with different windows, setup/move durations, a locked block.
// All times are entered as local wall clock (Asia/Shanghai) and stored as UTC.
const DATE = '2026-10-05';
const TZ = 'Asia/Shanghai';
const w = (a: string, b: string) => localWindowToUtc(DATE, a, b, TZ);
const at = (hhmm: string) => localToUtc(DATE, hhmm, TZ);

const A = uid(1); // performer 甲
const B = uid(2); // performer 乙
const L1 = uid(11); // 咖啡馆
const L2 = uid(12); // 街道
const L3 = uid(13); // 天台
const DOLLY = uid(21);
const [s1, s2, s3, s4, s5, s6, s7] = [101, 102, 103, 104, 105, 106, 107].map(uid) as [string, string, string, string, string, string, string];
const [U1, U2, U3, U4, U5] = [201, 202, 203, 204, 205].map(uid) as [string, string, string, string, string];

const INPUT: ScheduleInput = {
  date: DATE,
  timezone: TZ,
  crew_window: w('07:00', '20:00'),
  resources: [
    resource(A, 'performer', '演员甲', [w('07:00', '13:00')]),
    resource(B, 'performer', '演员乙', [w('12:00', '19:00')]),
    resource(L1, 'location', '咖啡馆', [w('07:00', '20:00')]),
    resource(L2, 'location', '街道', [w('09:00', '18:00')]),
    resource(L3, 'location', '天台', [w('07:00', '20:00')]),
    resource(DOLLY, 'equipment', '轨道车', [w('07:00', '20:00')]),
  ],
  shots: [shot(s1, [A]), shot(s2, [A]), shot(s3, [A, B]), shot(s4, [B]), shot(s5, [B]), shot(s6, [B]), shot(s7, [B], 'optional')],
  setups: [
    setup(U1, '1 咖啡馆 正打', { location: L1, shots: [s1, s2], setup: 30, perShot: 20, reset: 10 }),
    setup(U2, '2 咖啡馆 双人', { location: L1, shots: [s3], setup: 20, perShot: 30, reset: 10 }),
    // setup_min includes the company move to the street
    setup(U3, '3 街道 移动', { location: L2, shots: [s4, s5], equipment: [DOLLY], setup: 45, perShot: 25, reset: 15 }),
    setup(U4, '4 街道 锁定', { location: L2, shots: [s6], setup: 15, perShot: 30, reset: 10 }),
    setup(U5, '5 天台 黄昏', { location: L3, shots: [s7], setup: 20, perShot: 30, reset: 10 }),
  ],
  constraints: [locked(U4, at('16:00'), at('17:00')), notBefore(U5, at('17:30'))],
};

const label = new Map(INPUT.setups.map((s) => [s.id, s.label]));
const local = (iso: string) => utcToLocal(iso, TZ).time;

describe('AT-07 schedule: every placed block passes the independent validator', () => {
  const result = schedule(INPUT);

  test('feasible, contract-conformant, and validate() agrees', () => {
    expect(result.outcome).toBe('feasible');
    expect(result.unplaced).toEqual([]);
    expect(result.contradictions).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(validate(INPUT, result.blocks)).toEqual([]);
    expect(ScheduleResult.parse(result)).toEqual(result);
    expect(result.algorithm_version).toBe('greedy-1');
    expect(result.validator_version).toBe('validate-1');
  });

  test('golden timeline (local wall clock)', () => {
    const timeline = result.blocks.map((b) => `${label.get(b.setup_id!)} ${b.kind} ${local(b.start_utc)}-${local(b.end_utc)}${b.locked ? ' locked' : ''}`);
    expect(timeline).toEqual([
      '1 咖啡馆 正打 setup 07:00-07:30',
      '1 咖啡馆 正打 shoot 07:30-08:10',
      '1 咖啡馆 正打 reset 08:10-08:20',
      '2 咖啡馆 双人 setup 11:40-12:00',
      '2 咖啡馆 双人 shoot 12:00-12:30',
      '2 咖啡馆 双人 reset 12:30-12:40',
      '3 街道 移动 setup 12:40-13:25',
      '3 街道 移动 shoot 13:25-14:15',
      '3 街道 移动 reset 14:15-14:30',
      '4 街道 锁定 setup 16:00-16:15 locked',
      '4 街道 锁定 shoot 16:15-16:45 locked',
      '4 街道 锁定 reset 16:45-16:55 locked',
      '4 街道 锁定 buffer 16:55-17:00 locked',
      '5 天台 黄昏 setup 17:30-17:50',
      '5 天台 黄昏 shoot 17:50-18:20',
      '5 天台 黄昏 reset 18:20-18:30',
    ]);
    expect(result.order).toEqual([U1, U2, U3, U4, U5]);
  });

  test('no two blocks overlap and no resource is double-booked (checked test-side)', () => {
    expect(overlappingPairs(result.blocks)).toEqual([]);
    for (const r of INPUT.resources) {
      const mine = result.blocks.filter((b) => b.resource_ids.includes(r.id));
      expect(overlappingPairs(mine)).toEqual([]);
    }
  });

  test('each block sits inside the windows of every resource it uses; performers are on the shoot blocks', () => {
    const byId = new Map(INPUT.resources.map((r) => [r.id, r]));
    for (const b of result.blocks) for (const rid of b.resource_ids) expect(insideSomeWindow(byId.get(rid)!, b)).toBe(true);
    const shootOf = (u: string) => result.blocks.find((b) => b.setup_id === u && b.kind === 'shoot')!;
    expect(shootOf(U1).resource_ids).toEqual(expect.arrayContaining([A, L1]));
    expect(shootOf(U2).resource_ids).toEqual(expect.arrayContaining([A, B, L1]));
    expect(shootOf(U3).resource_ids).toEqual(expect.arrayContaining([B, L2, DOLLY]));
    // performers are not held during setup/reset
    const setupU2 = result.blocks.find((b) => b.setup_id === U2 && b.kind === 'setup')!;
    expect(setupU2.resource_ids).toEqual([L1]);
  });

  test('no duration is lost: setup + per_shot × shots + reset, back to back', () => {
    for (const s of INPUT.setups) {
      const own = result.blocks.filter((b) => b.setup_id === s.id);
      const minutesOf = (kind: string) => own.filter((b) => b.kind === kind).reduce((n, b) => n + blockMinutes(b), 0);
      const activeShots = s.shot_ids.length;
      expect(minutesOf('setup')).toBe(s.durations.setup_min);
      expect(minutesOf('shoot')).toBe(s.durations.per_shot_min * activeShots);
      expect(minutesOf('reset')).toBe(s.durations.reset_min);
      const parts = own.filter((b) => b.kind !== 'buffer');
      for (let i = 1; i < parts.length; i++) expect(ms(parts[i]!.start_utc)).toBe(ms(parts[i - 1]!.end_utc));
      const shoot = own.find((b) => b.kind === 'shoot')!;
      expect(shoot.shot_ids).toEqual(s.shot_ids);
    }
  });

  test('the locked block stays exactly where it was locked', () => {
    const own = result.blocks.filter((b) => b.setup_id === U4);
    expect(own.every((b) => b.locked)).toBe(true);
    expect(own[0]!.start_utc).toBe(at('16:00'));
    expect(own[own.length - 1]!.end_utc).toBe(at('17:00'));
    expect(result.blocks.filter((b) => b.setup_id !== U4).every((b) => !b.locked)).toBe(true);
  });

  test('deterministic: same input → identical result', () => {
    expect(schedule(INPUT)).toEqual(result);
    expect(JSON.stringify(schedule(structuredClone(INPUT)))).toBe(JSON.stringify(result));
  });
});
