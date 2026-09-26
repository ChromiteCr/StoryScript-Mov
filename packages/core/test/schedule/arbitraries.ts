import type { Constraint, Resource, Setup } from '@storyscript/contracts';
import fc from 'fast-check';
import type { ScheduleInput, ScheduleShot } from '../../src/schedule/types.ts';
import { uid } from './fixtures.ts';

/** Random single-day planning inputs for property tests (08:00–20:00 UTC, 5-min grid). */

const DAY0 = Date.parse('2026-10-05T08:00:00.000Z');
const STEP_MIN = 5;
const SLOTS = 144; // 12 h
export const at = (slot: number): string => new Date(DAY0 + slot * STEP_MIN * 60_000).toISOString();

const PERFORMERS = [uid(1), uid(2), uid(3)];
const LOCATIONS = [uid(11), uid(12)];
const EQUIPMENT = [uid(21)];

const slot = fc.integer({ min: 0, max: SLOTS });
const narrowWindow = fc
  .tuple(fc.integer({ min: 0, max: SLOTS - 1 }), fc.integer({ min: 1, max: SLOTS }))
  .map(([s, len]) => ({ start_utc: at(s), end_utc: at(Math.min(SLOTS, s + len)) }));
const wideWindow = fc
  .tuple(fc.integer({ min: 0, max: SLOTS / 3 }), fc.integer({ min: SLOTS / 2, max: SLOTS }))
  .map(([s, len]) => ({ start_utc: at(s), end_utc: at(Math.min(SLOTS, s + len)) }));
const windowsArb = fc.oneof(
  { weight: 14, arbitrary: fc.array(wideWindow, { minLength: 1, maxLength: 2 }) },
  { weight: 5, arbitrary: fc.array(narrowWindow, { minLength: 1, maxLength: 3 }) },
  { weight: 1, arbitrary: fc.constant([]) },
);
const confirmedArb = fc.oneof({ weight: 9, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) });

const shotArb = fc.record({
  performers: fc.oneof(
    { weight: 4, arbitrary: fc.subarray(PERFORMERS, { maxLength: 1 }) },
    { weight: 1, arbitrary: fc.subarray(PERFORMERS, { maxLength: 2 }) },
  ),
  status: fc.constantFrom('required', 'required', 'required', 'optional', 'waived') as fc.Arbitrary<ScheduleShot['required_status']>,
});

const setupArb = fc.record({
  location: fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...LOCATIONS) }, { weight: 1, arbitrary: fc.constant(null) }),
  equipment: fc.subarray(EQUIPMENT),
  shots: fc.array(shotArb, { minLength: 1, maxLength: 3 }),
  setup: fc.constantFrom(0, 5, 15, 30),
  perShot: fc.constantFrom(5, 10, 15, 20, 30, 45),
  reset: fc.constantFrom(0, 5, 10),
  estimate: fc.boolean(),
});

const constraintArb = (n: number) =>
  fc.oneof(
    // b ≠ a except (rarely) when there is a single setup, so cycles stay the exception
    {
      weight: 3,
      arbitrary: fc
        .record({ type: fc.constant('before' as const), a: fc.nat(n - 1), off: fc.nat(Math.max(0, n - 2)), confirmed: confirmedArb })
        .map(({ type, a, off, confirmed }) => ({ type, a, b: n > 1 ? (a + 1 + off) % n : a, confirmed })),
    },
    { weight: 2, arbitrary: fc.record({ type: fc.constant('not_before' as const), s: fc.nat(n - 1), at: slot, confirmed: confirmedArb }) },
    { weight: 2, arbitrary: fc.record({ type: fc.constant('not_after' as const), s: fc.nat(n - 1), at: slot, confirmed: confirmedArb }) },
    {
      weight: 2,
      arbitrary: fc.record({
        type: fc.constant('locked' as const),
        s: fc.nat(n - 1),
        start: fc.integer({ min: 0, max: SLOTS - 1 }),
        len: fc.integer({ min: 6, max: 60 }),
        /** most locks are sized to fit the setup, some are random */
        fit: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
        confirmed: confirmedArb,
      }),
    },
  );

export function scheduleInputArb(maxSetups = 6): fc.Arbitrary<ScheduleInput> {
  return fc
    .record({
      crew: fc.oneof(
        { weight: 3, arbitrary: fc.constant([0, SLOTS] as const) },
        { weight: 1, arbitrary: fc.tuple(fc.integer({ min: 0, max: 24 }), fc.integer({ min: 96, max: SLOTS })) },
      ),
      resources: fc.tuple(
        ...[...PERFORMERS, ...LOCATIONS, ...EQUIPMENT].map(() => fc.record({ windows: windowsArb, confirmed: confirmedArb })),
      ),
      setups: fc.array(setupArb, { minLength: 1, maxLength: maxSetups }),
    })
    .chain((base) =>
      fc.record({
        base: fc.constant(base),
        constraints: fc.array(constraintArb(base.setups.length), { maxLength: 3 }),
      }),
    )
    .map(({ base, constraints }) => build(base, constraints));
}

type Base = {
  crew: readonly [number, number];
  resources: { windows: readonly { start_utc: string; end_utc: string }[]; confirmed: boolean }[];
  setups: {
    location: string | null;
    equipment: string[];
    shots: { performers: string[]; status: ScheduleShot['required_status'] }[];
    setup: number;
    perShot: number;
    reset: number;
    estimate: boolean;
  }[];
};
type RawConstraint =
  | { type: 'before'; a: number; b: number; confirmed: boolean }
  | { type: 'not_before' | 'not_after'; s: number; at: number; confirmed: boolean }
  | { type: 'locked'; s: number; start: number; len: number; fit: boolean; confirmed: boolean };

function build(base: Base, raw: RawConstraint[]): ScheduleInput {
  const ids = [...PERFORMERS, ...LOCATIONS, ...EQUIPMENT];
  const resources: Resource[] = ids.map((id, i) => ({
    id,
    type: i < 3 ? 'performer' : i < 5 ? 'location' : 'equipment',
    name: `R${i}`,
    windows: [...base.resources[i]!.windows],
    cast_character_ids: [],
    confirmed: base.resources[i]!.confirmed,
  }));
  const shots: ScheduleShot[] = [];
  const setupIds = base.setups.map((_, i) => uid(0x200 + i));
  const setups: Setup[] = base.setups.map((s, i) => {
    const shotIds = s.shots.map((sh) => {
      const id = uid(0x100 + shots.length);
      shots.push({ id, required_status: sh.status, performer_ids: sh.performers });
      return id;
    });
    return {
      id: setupIds[i]!,
      label: `S${i}`,
      location_resource_id: s.location,
      shot_ids: shotIds,
      resource_ids: s.equipment,
      durations: { setup_min: s.setup, per_shot_min: s.perShot, reset_min: s.reset },
      estimate_confirmed: s.estimate,
    };
  });
  const constraints: Constraint[] = raw.map((c, i) => {
    const id = uid(0x300 + i);
    switch (c.type) {
      case 'before':
        return { id, type: 'before', a_setup_id: setupIds[c.a]!, b_setup_id: setupIds[c.b]!, confirmed: c.confirmed };
      case 'not_before':
      case 'not_after':
        return { id, type: c.type, setup_id: setupIds[c.s]!, at_utc: at(c.at), confirmed: c.confirmed };
      case 'locked': {
        const s = setups[c.s]!;
        const active = s.shot_ids.filter((sid) => shots.find((x) => x.id === sid)?.required_status !== 'waived').length;
        const total = s.durations.setup_min + s.durations.per_shot_min * active + s.durations.reset_min;
        const len = c.fit ? Math.ceil(total / STEP_MIN) + (c.len % 3) : c.len;
        return {
          id,
          type: 'locked_block',
          setup_id: setupIds[c.s]!,
          start_utc: at(c.start),
          end_utc: at(Math.min(SLOTS, c.start + len)),
          confirmed: c.confirmed,
        };
      }
    }
  });
  return {
    date: '2026-10-05',
    timezone: 'UTC',
    crew_window: { start_utc: at(base.crew[0]), end_utc: at(base.crew[1]) },
    setups,
    resources,
    shots,
    constraints,
  };
}
