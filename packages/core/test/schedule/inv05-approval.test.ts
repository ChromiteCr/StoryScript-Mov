import { describe, expect, test } from 'vitest';
import { canApprovePlan, planInputHash, schedule } from '../../src/schedule/schedule.ts';
import { approvalBlockers } from '../../src/schedule/validate.ts';
import type { ScheduleInput } from '../../src/schedule/types.ts';
import { input, resource, setup, shot, uid, win } from './fixtures.ts';

const P = uid(1);
const [a, b] = [uid(101), uid(102)];
const [X, Y] = [uid(201), uid(202)];

function data(opts: { estimate?: boolean; performerConfirmed?: boolean; longY?: boolean } = {}): ScheduleInput {
  return input({
    crew_window: win('08:00', '12:00'),
    resources: [resource(P, 'performer', 'P', [win('08:00', '12:00')], opts.performerConfirmed ?? true)],
    shots: [shot(a, [P]), shot(b)],
    setups: [
      setup(X, 'X', { shots: [a], perShot: 60, confirmed: opts.estimate ?? true }),
      setup(Y, 'Y', { shots: [b], perShot: opts.longY ? 200 : 60 }),
    ],
  });
}

const check = (d: ScheduleInput) => canApprovePlan(d, schedule(d), planInputHash(d));

describe('INV-05 approval gate: feasible + no violations + confirmed + not stale', () => {
  test('all conditions met → approvable', () => {
    expect(check(data())).toEqual({ ok: true, stale: false, outcome_ok: true, blockers: [] });
  });

  test('unconfirmed duration estimate blocks approval', () => {
    const r = check(data({ estimate: false }));
    expect(r.ok).toBe(false);
    expect(r.outcome_ok).toBe(true);
    expect(r.blockers).toEqual([expect.objectContaining({ code: 'ESTIMATE_UNCONFIRMED', setup_id: X })]);
  });

  test('unconfirmed resource blocks approval', () => {
    const r = check(data({ performerConfirmed: false }));
    expect(r.ok).toBe(false);
    expect(r.blockers).toEqual([expect.objectContaining({ code: 'MISSING_INPUT', resource_id: P })]);
  });

  test('partial plan (greedy could not place everything) blocks approval', () => {
    const d = data({ longY: true });
    const res = schedule(d);
    expect(res.outcome).toBe('partial');
    const r = canApprovePlan(d, res, planInputHash(d));
    expect(r.ok).toBe(false);
    expect(r.outcome_ok).toBe(false);
    expect(r.blockers.map((v) => v.code)).toContain('UNPLACED_REQUIRED');
  });

  test('stale basis hash or foreign validator version blocks approval', () => {
    const d = data();
    const res = schedule(d);
    expect(canApprovePlan(d, res, 'not-the-basis').ok).toBe(false);
    expect(canApprovePlan(d, { ...res, validator_version: 'validate-0' }, planInputHash(d)).stale).toBe(true);
  });

  test('hand-edited blocks cannot bypass validation', () => {
    const d = data();
    const res = schedule(d);
    const moved = { ...res, blocks: res.blocks.map((blk) => ({ ...blk, start_utc: '2026-10-05T07:00:00.000Z' })) };
    const codes = approvalBlockers(d, moved).map((v) => v.code);
    expect(codes).toContain('OUTSIDE_WINDOW');
    expect(canApprovePlan(d, moved, planInputHash(d)).ok).toBe(false);
  });
});
