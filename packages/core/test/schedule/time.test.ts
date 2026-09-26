import { describe, expect, test } from 'vitest';
import { schedule } from '../../src/schedule/schedule.ts';
import {
  contains,
  intersectSets,
  localToUtc,
  localWindowToUtc,
  longestSegment,
  mergeIntervals,
  minutes,
  overlaps,
  utcToLocal,
  windowToInterval,
} from '../../src/schedule/time.ts';
import { validate } from '../../src/schedule/validate.ts';
import { resource, setup, shot, uid } from './fixtures.ts';

const NY = 'America/New_York';

describe('localToUtc', () => {
  test('fixed-offset zone', () => {
    expect(localToUtc('2026-10-05', '08:00', 'Asia/Shanghai')).toBe('2026-10-05T00:00:00.000Z');
    expect(localToUtc('2026-10-05', '07:30', 'Asia/Shanghai')).toBe('2026-10-04T23:30:00.000Z');
    expect(localToUtc('2026-10-05', '08:00', 'UTC')).toBe('2026-10-05T08:00:00.000Z');
  });

  test('America/New_York spring forward (2026-03-08): gap resolves forward', () => {
    expect(localToUtc('2026-03-08', '01:30', NY)).toBe('2026-03-08T06:30:00.000Z'); // EST
    expect(localToUtc('2026-03-08', '02:30', NY)).toBe('2026-03-08T07:30:00.000Z'); // does not exist → 03:30 EDT
    expect(localToUtc('2026-03-08', '03:30', NY)).toBe('2026-03-08T07:30:00.000Z'); // EDT
    expect(utcToLocal('2026-03-08T07:30:00.000Z', NY)).toEqual({ date: '2026-03-08', time: '03:30' });
    // a 00:00–06:00 local window lasts 5 real hours on this day
    expect(minutes(windowToInterval(localWindowToUtc('2026-03-08', '00:00', '06:00', NY)))).toBe(300);
  });

  test('America/New_York fall back (2026-11-01): ambiguous time takes the earlier instant', () => {
    expect(localToUtc('2026-11-01', '00:30', NY)).toBe('2026-11-01T04:30:00.000Z'); // EDT
    expect(localToUtc('2026-11-01', '01:30', NY)).toBe('2026-11-01T05:30:00.000Z'); // first 01:30 (EDT)
    expect(localToUtc('2026-11-01', '02:30', NY)).toBe('2026-11-01T07:30:00.000Z'); // EST
    expect(minutes(windowToInterval(localWindowToUtc('2026-11-01', '00:00', '03:00', NY)))).toBe(240);
  });

  test('crossing midnight is explicit: dayOffset or an end ≤ start window', () => {
    expect(localToUtc('2026-10-05', '02:00', 'Asia/Shanghai', 1)).toBe('2026-10-05T18:00:00.000Z');
    expect(localWindowToUtc('2026-10-05', '22:00', '02:00', 'Asia/Shanghai')).toEqual({
      start_utc: '2026-10-05T14:00:00.000Z',
      end_utc: '2026-10-05T18:00:00.000Z',
    });
    // month end rolls into the next month
    expect(localWindowToUtc('2026-10-31', '23:00', '01:00', 'UTC')).toEqual({
      start_utc: '2026-10-31T23:00:00.000Z',
      end_utc: '2026-11-01T01:00:00.000Z',
    });
    // overnight across the fall-back transition: 22:00 EDT → 02:00 EST is 5 h
    const night = localWindowToUtc('2026-10-31', '22:00', '02:00', NY);
    expect(night).toEqual({ start_utc: '2026-11-01T02:00:00.000Z', end_utc: '2026-11-01T07:00:00.000Z' });
    expect(minutes(windowToInterval(night))).toBe(300);
  });

  test.each([
    ['2026-02-30', '08:00', 'UTC'],
    ['2026-1-05', '08:00', 'UTC'],
    ['2026-10-05', '24:00', 'UTC'],
    ['2026-10-05', '8:00', 'UTC'],
    ['2026-10-05', '08:00', 'Nowhere/Nothing'],
  ])('rejects %s %s %s', (date, time, tz) => {
    expect(() => localToUtc(date, time, tz)).toThrow(RangeError);
  });
});

describe('half-open interval tools', () => {
  const iv = (start: number, end: number) => ({ start, end });

  test('overlaps: touching intervals do not overlap; empty never overlaps', () => {
    expect(overlaps(iv(0, 10), iv(10, 20))).toBe(false);
    expect(overlaps(iv(0, 10), iv(9, 20))).toBe(true);
    expect(overlaps(iv(5, 5), iv(0, 10))).toBe(false);
  });

  test('contains and minutes', () => {
    expect(contains(iv(0, 10), iv(0, 10))).toBe(true);
    expect(contains(iv(0, 10), iv(1, 11))).toBe(false);
    expect(minutes(iv(0, 90 * 60_000))).toBe(90);
    expect(minutes(iv(10, 0))).toBe(0);
  });

  test('merge / intersect / longest segment', () => {
    expect(mergeIntervals([iv(5, 8), iv(0, 5), iv(9, 10), iv(3, 3)])).toEqual([iv(0, 8), iv(9, 10)]);
    expect(intersectSets([iv(0, 10), iv(20, 30)], [iv(5, 25)])).toEqual([iv(5, 10), iv(20, 25)]);
    expect(longestSegment([iv(0, 4), iv(4, 9), iv(20, 25)])).toBe(9);
    expect(intersectSets([iv(0, 10)], [iv(-Infinity, 6)])).toEqual([iv(0, 6)]);
  });
});

describe('scheduling across midnight and DST', () => {
  const P = uid(1);
  const [a, b] = [uid(101), uid(102)];
  const [X, Y] = [uid(201), uid(202)];

  test('night shoot crossing midnight (local 20:00 → 04:00 next day)', () => {
    const TZ = 'Asia/Shanghai';
    const data = {
      date: '2026-10-05',
      timezone: TZ,
      crew_window: localWindowToUtc('2026-10-05', '20:00', '04:00', TZ),
      resources: [resource(P, 'performer', 'P', [localWindowToUtc('2026-10-05', '23:00', '03:00', TZ)])],
      shots: [shot(a, [P]), shot(b)],
      setups: [setup(X, 'X', { shots: [a], setup: 30, perShot: 120 }), setup(Y, 'Y', { shots: [b], perShot: 60 })],
      constraints: [],
    };
    const r = schedule(data);
    expect(r.outcome).toBe('feasible');
    expect(validate(data, r.blocks)).toEqual([]);
    const shootX = r.blocks.find((blk) => blk.setup_id === X && blk.kind === 'shoot')!;
    expect(utcToLocal(shootX.start_utc, TZ)).toEqual({ date: '2026-10-05', time: '23:00' });
    expect(utcToLocal(shootX.end_utc, TZ)).toEqual({ date: '2026-10-06', time: '01:00' });
  });

  test('DST spring-forward day: the local 00:00–06:00 crew day holds 5 h of work, not 6', () => {
    const base = (perShot: number) => ({
      date: '2026-03-08',
      timezone: NY,
      crew_window: localWindowToUtc('2026-03-08', '00:00', '06:00', NY),
      resources: [],
      shots: [shot(a)],
      setups: [setup(X, 'X', { shots: [a], perShot })],
      constraints: [],
    });
    expect(schedule(base(300)).outcome).toBe('feasible');
    const tooLong = schedule(base(330));
    expect(tooLong.outcome).toBe('proven_infeasible');
    expect(tooLong.contradictions[0]!.code).toBe('BLOCK_EXCEEDS_WINDOWS');
    // block times reported in local time jump from 01:59 to 03:00
    const blk = schedule(base(300)).blocks[0]!;
    expect(utcToLocal(blk.start_utc, NY).time).toBe('00:00');
    expect(utcToLocal(blk.end_utc, NY).time).toBe('06:00');
  });
});
