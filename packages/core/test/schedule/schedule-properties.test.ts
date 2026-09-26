import { ScheduleResult, type ScheduleBlock, type ViolationCode } from '@storyscript/contracts';
import fc from 'fast-check';
import { afterAll, describe, expect, test } from 'vitest';
import { mulberry32 } from '../../src/util/random.ts';
import { greedySchedule, reorder, schedule } from '../../src/schedule/schedule.ts';
import type { ScheduleInput } from '../../src/schedule/types.ts';
import { validate } from '../../src/schedule/validate.ts';
import { scheduleInputArb } from './arbitraries.ts';
import { ms, overlappingPairs } from './fixtures.ts';

/** Total fast-check runs, reported in the milestone measurements. */
const RUNS = { accept: 1000, inject: 1000, derived: 500, soundness: 400, completeness: 400, determinism: 300, idempotent: 300 };
const tally: Record<string, number> = {};
const count = (key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};
afterAll(() => {
  // one line, handy when collecting measurements
  console.info(`[schedule properties] runs=${JSON.stringify(RUNS)} tally=${JSON.stringify(tally)}`);
});

const iso = (n: number): string => new Date(n).toISOString();
const shift = (b: ScheduleBlock, start: number): ScheduleBlock => ({
  ...b,
  start_utc: iso(start),
  end_utc: iso(start + ms(b.end_utc) - ms(b.start_utc)),
});

describe('validate() accepts every greedy placement', () => {
  test('random inputs: greedy output has no violation except UNPLACED_REQUIRED of unplaced setups', () => {
    fc.assert(
      fc.property(scheduleInputArb(), (input) => {
        const g = greedySchedule(input);
        const unplaced = new Set(g.unplaced.map((u) => u.setup_id));
        const v = validate(input, g.blocks);
        expect(v.filter((x) => x.code !== 'UNPLACED_REQUIRED')).toEqual([]);
        for (const x of v) expect(unplaced.has(x.setup_id!)).toBe(true);
        expect(overlappingPairs(g.blocks)).toEqual([]);
        if (g.blocks.length > 0) count('accept:with_blocks');

        const r = schedule(input);
        count(`outcome:${r.outcome}`);
        expect(ScheduleResult.safeParse(r).success).toBe(true);
        if (r.outcome === 'feasible' || r.outcome === 'partial') {
          expect(r.violations).toEqual(validate(input, r.blocks));
          // feasible ⇔ no violation; an unplaced required setup always yields UNPLACED_REQUIRED,
          // unplaced optional setups may remain listed in a feasible plan
          expect(r.outcome === 'feasible').toBe(r.violations.length === 0);
          expect(r.contradictions).toEqual([]);
        } else if (r.outcome === 'proven_infeasible') {
          expect(r.contradictions.length).toBeGreaterThan(0);
          for (const c of r.contradictions) expect(c.setup_ids.length).toBeGreaterThan(0);
        } else {
          expect(r.outcome).toBe('needs_input');
          expect(r.violations.length).toBeGreaterThan(0);
          expect(r.violations.every((x) => x.code === 'MISSING_INPUT')).toBe(true);
        }
      }),
      { numRuns: RUNS.accept },
    );
  });
});

describe('validate() rejects injected faults in greedy output', () => {
  const faults = ['overlap', 'before_crew', 'after_crew', 'drop_window', 'move_locked', 'drop_required', 'precedence'] as const;

  test('every injected overlap / out-of-window / moved / missing / out-of-order block is reported', () => {
    fc.assert(
      fc.property(scheduleInputArb(), fc.constantFrom(...faults), fc.nat(), fc.nat(), (input, fault, i, j) => {
        const { blocks } = greedySchedule(input);
        if (blocks.length === 0) return;
        const pick = blocks[i % blocks.length]!;
        let mutatedInput: ScheduleInput = input;
        let mutated: ScheduleBlock[] | null = null;
        let expected: ViolationCode;
        switch (fault) {
          case 'overlap': {
            if (blocks.length < 2) return;
            const k = j % blocks.length === i % blocks.length ? (j + 1) % blocks.length : j % blocks.length;
            const other = blocks[k]!;
            mutated = blocks.map((b) => (b === pick ? shift(b, ms(other.start_utc)) : b));
            expected = 'CREW_OVERLAP';
            break;
          }
          case 'before_crew': {
            const dur = ms(pick.end_utc) - ms(pick.start_utc);
            mutated = blocks.map((b) => (b === pick ? shift(b, ms(input.crew_window.start_utc) - dur) : b));
            expected = 'OUTSIDE_WINDOW';
            break;
          }
          case 'after_crew': {
            mutated = blocks.map((b) => (b === pick ? shift(b, ms(input.crew_window.end_utc) - 60_000) : b));
            expected = 'OUTSIDE_WINDOW';
            break;
          }
          case 'drop_window': {
            const rid = pick.resource_ids[j % Math.max(1, pick.resource_ids.length)];
            if (!rid) return;
            mutatedInput = { ...input, resources: input.resources.map((r) => (r.id === rid ? { ...r, windows: [] } : r)) };
            // blocks also "forget" their resources: validate must re-derive them from the input
            mutated = blocks.map((b) => ({ ...b, resource_ids: [] }));
            expected = 'OUTSIDE_WINDOW';
            break;
          }
          case 'move_locked': {
            const lockedSetup = blocks.find((b) => b.locked)?.setup_id;
            if (!lockedSetup) return;
            mutated = blocks.map((b) => (b.setup_id === lockedSetup ? shift(b, ms(b.start_utc) + 5 * 60_000) : b));
            expected = 'LOCKED_BLOCK_MOVED';
            break;
          }
          case 'drop_required': {
            const shots = new Map(input.shots.map((s) => [s.id, s]));
            const victim = blocks.find((b) => b.kind === 'shoot' && b.shot_ids.some((id) => shots.get(id)?.required_status === 'required'));
            if (!victim) return;
            mutated = blocks.filter((b) => b.setup_id !== victim.setup_id);
            expected = 'UNPLACED_REQUIRED';
            break;
          }
          case 'precedence': {
            const placed = new Set(blocks.map((b) => b.setup_id));
            const c = input.constraints.find(
              (x) => x.type === 'before' && x.confirmed && x.a_setup_id !== x.b_setup_id && placed.has(x.a_setup_id) && placed.has(x.b_setup_id),
            );
            if (!c || c.type !== 'before') return;
            const startOf = (id: string) => Math.min(...blocks.filter((b) => b.setup_id === id).map((b) => ms(b.start_utc)));
            const delta = startOf(c.a_setup_id) - startOf(c.b_setup_id);
            mutated = blocks.map((b) => (b.setup_id === c.b_setup_id ? shift(b, ms(b.start_utc) + delta) : b));
            expected = 'PRECEDENCE';
            break;
          }
        }
        count(`inject:${fault}`);
        const codes = validate(mutatedInput, mutated).map((v) => v.code);
        expect(codes).toContain(expected);
      }),
      { numRuns: RUNS.inject },
    );
  });
});

describe('validate() enforces constraints derived from a greedy placement', () => {
  test('lock a placed setup where it is → clean; move it → LOCKED_BLOCK_MOVED. Order two setups → clean; swap → PRECEDENCE', () => {
    fc.assert(
      fc.property(scheduleInputArb(), fc.nat(), fc.nat(), fc.integer({ min: 1, max: 120 }), (input, i, j, minutesShift) => {
        const { blocks } = greedySchedule(input);
        const spans = new Map<string, { start: number; end: number }>();
        for (const b of blocks) {
          const s = spans.get(b.setup_id!);
          const [start, end] = [ms(b.start_utc), ms(b.end_utc)];
          spans.set(b.setup_id!, s ? { start: Math.min(s.start, start), end: Math.max(s.end, end) } : { start, end });
        }
        const placed = [...spans.keys()].sort();
        if (placed.length === 0) return;
        const baseline = validate(input, blocks).length;

        // locked_block derived from the actual placement
        const target = placed[i % placed.length]!;
        const span = spans.get(target)!;
        const withLock: ScheduleInput = {
          ...input,
          constraints: [
            ...input.constraints.filter((c) => !(c.type === 'locked_block' && c.setup_id === target)),
            { id: '00000000-0000-4000-8000-00000000ffff', type: 'locked_block', setup_id: target, start_utc: iso(span.start), end_utc: iso(span.end), confirmed: true },
          ],
        };
        expect(validate(withLock, blocks).length).toBe(baseline);
        const moved = blocks.map((b) => (b.setup_id === target ? shift(b, ms(b.start_utc) + minutesShift * 60_000) : b));
        expect(validate(withLock, moved).map((v) => v.code)).toContain('LOCKED_BLOCK_MOVED');
        count('derived:locked');

        // before(A, B) derived from two placed setups in time order
        if (placed.length < 2) return;
        const [a, b] = [placed[i % placed.length]!, placed[(i + 1 + (j % (placed.length - 1))) % placed.length]!];
        const [first, second] = spans.get(a)!.start < spans.get(b)!.start ? [a, b] : [b, a];
        const withBefore: ScheduleInput = {
          ...input,
          constraints: [
            ...input.constraints,
            { id: '00000000-0000-4000-8000-00000000fffe', type: 'before', a_setup_id: first, b_setup_id: second, confirmed: true },
          ],
        };
        expect(validate(withBefore, blocks).length).toBe(baseline);
        const delta = spans.get(first)!.start - spans.get(second)!.start;
        const swapped = blocks.map((blk) => (blk.setup_id === second ? shift(blk, ms(blk.start_utc) + delta) : blk));
        expect(validate(withBefore, swapped).map((v) => v.code)).toContain('PRECEDENCE');
        count('derived:precedence');
      }),
      { numRuns: RUNS.derived },
    );
  });
});

describe('proven_infeasible is sound', () => {
  test('if any setup order lets greedy place every required setup cleanly, no contradiction is reported', () => {
    fc.assert(
      fc.property(scheduleInputArb(4), (input) => {
        const r = schedule(input);
        if (r.outcome !== 'proven_infeasible') return;
        count('soundness:proven_infeasible_checked');
        const shots = new Map(input.shots.map((s) => [s.id, s]));
        const active = input.setups.filter((s) => s.shot_ids.some((id) => shots.get(id)?.required_status !== 'waived')).map((s) => s.id);
        for (const perm of permutations(active)) {
          const g = greedySchedule(input, perm);
          const clean = validate(input, g.blocks).length === 0;
          // a clean validation means every required shot is placed without any violation
          expect(clean).toBe(false);
        }
      }),
      { numRuns: RUNS.soundness },
    );
  });
});

describe('small days are searched completely', () => {
  test('if any setup order gives a clean plan, schedule() returns feasible (≤ 4 setups)', () => {
    fc.assert(
      fc.property(scheduleInputArb(4), (input) => {
        const r = schedule(input);
        if (r.outcome !== 'partial') return;
        count('completeness:partial_checked');
        const shots = new Map(input.shots.map((s) => [s.id, s]));
        const active = input.setups.filter((s) => s.shot_ids.some((id) => shots.get(id)?.required_status !== 'waived')).map((s) => s.id);
        for (const perm of permutations(active)) {
          // no order may be clean while the scheduler settled for partial
          expect(validate(input, greedySchedule(input, perm).blocks)).not.toEqual([]);
        }
      }),
      { numRuns: RUNS.completeness },
    );
  });
});

describe('determinism', () => {
  test('same input → same result; collection order of the input is irrelevant', () => {
    fc.assert(
      fc.property(scheduleInputArb(), fc.integer(), (input, seed) => {
        const rng = mulberry32(seed);
        const shuffle = <T>(xs: readonly T[]): T[] => {
          const a = [...xs];
          for (let k = a.length - 1; k > 0; k--) {
            const m = Math.floor(rng() * (k + 1));
            [a[k], a[m]] = [a[m]!, a[k]!];
          }
          return a;
        };
        const shuffled: ScheduleInput = {
          ...input,
          setups: shuffle(input.setups).map((s) => ({ ...s, resource_ids: shuffle(s.resource_ids) })),
          resources: shuffle(input.resources).map((r) => ({ ...r, windows: shuffle(r.windows) })),
          shots: shuffle(input.shots).map((s) => ({ ...s, performer_ids: shuffle(s.performer_ids) })),
          constraints: shuffle(input.constraints),
        };
        const r = schedule(input);
        expect(schedule(input)).toEqual(r);
        expect(schedule(shuffled)).toEqual(r);
      }),
      { numRuns: RUNS.determinism },
    );
  });

  test('re-planning with the result order reproduces the same placement (reorder is idempotent)', () => {
    fc.assert(
      fc.property(scheduleInputArb(), (input) => {
        const r = schedule(input);
        if (r.outcome !== 'feasible' && r.outcome !== 'partial') return;
        count('idempotent:checked');
        const again = reorder(input, r.order);
        expect(again.blocks).toEqual(r.blocks);
        expect(again.order).toEqual(r.order);
        expect(again.unplaced.map((u) => u.setup_id)).toEqual(r.unplaced.map((u) => u.setup_id));
        expect(again.outcome).toBe(r.outcome);
      }),
      { numRuns: RUNS.idempotent },
    );
  });
});

function* permutations<T>(xs: readonly T[]): Generator<T[]> {
  if (xs.length <= 1) {
    yield [...xs];
    return;
  }
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) yield [xs[i]!, ...p];
  }
}
