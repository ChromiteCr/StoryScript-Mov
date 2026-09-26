import { describe, expect, test } from 'vitest';
import { schedule } from '../../src/schedule/schedule.ts';
import { validate } from '../../src/schedule/validate.ts';
import { input, resource, setup, shot, uid, win } from './fixtures.ts';

// AT-07 "工时不遗漏": the validator re-derives every part's length from the raw
// setup and checks parts run back to back, independently of the placer.
const L = uid(11);
const [a, b] = [uid(101), uid(102)] as [string, string];
const U = uid(201);
const data = input({
  crew_window: win('08:00', '18:00'),
  resources: [resource(L, 'location', 'L', [win('08:00', '18:00')])],
  shots: [shot(a), shot(b)],
  setups: [setup(U, 'U', { location: L, shots: [a, b], setup: 30, perShot: 20, reset: 10 })],
});

describe('validator: durations and part sequence', () => {
  test('a clean greedy plan has setup 30 → shoot 40 → reset 10, back to back', () => {
    const r = schedule(data);
    expect(r.outcome).toBe('feasible');
    expect(r.blocks.map((x) => x.kind)).toEqual(['setup', 'shoot', 'reset']);
  });

  test('a shortened shoot block is DURATION_MISMATCH', () => {
    const blocks = schedule(data).blocks.map((x) =>
      x.kind === 'shoot' ? { ...x, end_utc: new Date(Date.parse(x.end_utc) - 10 * 60_000).toISOString() } : x,
    );
    const codes = validate(data, blocks).map((v) => v.code);
    expect(codes).toContain('DURATION_MISMATCH');
  });

  test('reset before shoot, or a gap between parts, is BLOCK_SEQUENCE', () => {
    const [s, sh, rs] = schedule(data).blocks as [any, any, any];
    const swapped = [s, { ...rs, start_utc: sh.start_utc, end_utc: new Date(Date.parse(sh.start_utc) + 10 * 60_000).toISOString() }, { ...sh, start_utc: new Date(Date.parse(sh.start_utc) + 10 * 60_000).toISOString(), end_utc: new Date(Date.parse(sh.start_utc) + 50 * 60_000).toISOString() }];
    expect(validate(data, swapped).map((v) => v.code)).toContain('BLOCK_SEQUENCE');
    const gap = [s, { ...sh, start_utc: new Date(Date.parse(sh.start_utc) + 5 * 60_000).toISOString(), end_utc: new Date(Date.parse(sh.end_utc) + 5 * 60_000).toISOString() }, { ...rs, start_utc: new Date(Date.parse(rs.start_utc) + 5 * 60_000).toISOString(), end_utc: new Date(Date.parse(rs.end_utc) + 5 * 60_000).toISOString() }];
    expect(validate(data, gap).map((v) => v.code)).toContain('BLOCK_SEQUENCE');
  });

  test('unplaced entries carry a machine-readable code', () => {
    const tight = input({
      crew_window: win('08:00', '09:00'),
      resources: [resource(L, 'location', 'L', [win('08:00', '09:00')])],
      shots: [shot(a, [], 'optional'), shot(b)],
      setups: [setup(U, 'U', { location: L, shots: [a], setup: 30, perShot: 60, reset: 10 }), setup(uid(202), 'V', { location: L, shots: [b], perShot: 30 })],
    });
    const r = schedule(tight);
    for (const u of r.unplaced) expect(u.reason.startsWith(`${u.code}:`)).toBe(true);
  });
});
