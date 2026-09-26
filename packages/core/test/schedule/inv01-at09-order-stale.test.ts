import { describe, expect, expectTypeOf, test } from 'vitest';
import { canApprovePlan, planInputHash, reorder, schedule } from '../../src/schedule/schedule.ts';
import type { ScheduleInput, ScheduleShot } from '../../src/schedule/types.ts';
import { deepFreeze, input, resource, setup, shot, uid, win } from './fixtures.ts';

const P = uid(1);
const [a, b, c] = [uid(101), uid(102), uid(103)];
const [X, Y, W] = [uid(201), uid(202), uid(203)];

function base(): ScheduleInput {
  return input({
    resources: [resource(P, 'performer', 'P', [win('08:00', '20:00')])],
    shots: [shot(a, [P]), shot(b), shot(c)],
    setups: [setup(X, 'X', { shots: [a] }), setup(Y, 'Y', { shots: [b] }), setup(W, 'W', { shots: [c] })],
  });
}

describe('INV-01 scheduling never reads or writes narrative order', () => {
  test('the scheduler input has no narrative field at all (type level)', () => {
    type ShotKeys = keyof ScheduleShot;
    expectTypeOf<'narrative_pos' extends ShotKeys ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'narrative_pos' extends keyof ScheduleInput ? true : false>().toEqualTypeOf<false>();
    // the only order the scheduler knows about is setup order
    expectTypeOf<ScheduleInput['order_override']>().toEqualTypeOf<readonly string[] | undefined>();
  });

  test('extra narrative data is neither read nor mutated, and never echoed', () => {
    const withNarrative = (pos: number[]) => {
      const data = base();
      return deepFreeze({
        ...data,
        shots: data.shots.map((s, i) => ({ ...s, narrative_pos: pos[i]!, code: `${i + 1}` })),
      }) as ScheduleInput;
    };
    const frozen = withNarrative([1, 2, 3]);
    const snapshot = JSON.stringify(frozen);
    const r1 = schedule(frozen); // deep-frozen: any write would throw in strict mode
    const r2 = schedule(withNarrative([3, 1, 2]));
    expect(JSON.stringify(frozen)).toBe(snapshot);
    expect(r2).toEqual(r1);
    expect(JSON.stringify(r1)).not.toContain('narrative');
  });

  test('reordering the shooting plan leaves the shots (and their narrative data) untouched', () => {
    const data = deepFreeze(base());
    const before = JSON.stringify(data.shots);
    const r = reorder(data, [W, Y, X]);
    expect(r.order).toEqual([W, Y, X]);
    expect(JSON.stringify(data.shots)).toBe(before);
  });
});

describe('AT-09 (pure part): change order, change a window, try to approve the old plan', () => {
  test('a window change makes the stored plan stale and approval is blocked until re-planned', () => {
    const data = base();
    const plan = schedule(data);
    const basis = planInputHash(data);
    expect(canApprovePlan(data, plan, basis)).toMatchObject({ ok: true, stale: false });

    // manual move: new order, new basis, still approvable after re-validation
    const moved = reorder(data, [Y, X, W]);
    const movedInput = { ...data, order_override: [Y, X, W] };
    expect(moved.order).toEqual([Y, X, W]);
    expect(planInputHash(movedInput)).not.toBe(basis);
    expect(canApprovePlan(movedInput, moved, planInputHash(movedInput)).ok).toBe(true);

    // performer window changes → the old plan is stale
    const changed = { ...data, resources: [resource(P, 'performer', 'P', [win('12:00', '20:00')])] };
    const staleCheck = canApprovePlan(changed, plan, basis);
    expect(staleCheck.stale).toBe(true);
    expect(staleCheck.ok).toBe(false);
    // the old blocks also violate the new window
    expect(staleCheck.blockers.map((v) => v.code)).toContain('OUTSIDE_WINDOW');

    // re-plan → approvable again
    const replanned = schedule(changed);
    expect(canApprovePlan(changed, replanned, planInputHash(changed)).ok).toBe(true);
  });

  test('planInputHash ignores collection order but not content', () => {
    const data = base();
    const shuffled = { ...data, setups: [...data.setups].reverse(), shots: [...data.shots].reverse() };
    expect(planInputHash(shuffled)).toBe(planInputHash(data));
    expect(schedule(shuffled)).toEqual(schedule(data));
    const edited = { ...data, setups: data.setups.map((s) => (s.id === X ? { ...s, durations: { ...s.durations, reset_min: 5 } } : s)) };
    expect(planInputHash(edited)).not.toBe(planInputHash(data));
  });
});
