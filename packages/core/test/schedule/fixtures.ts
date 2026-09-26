import type { Constraint, Resource, ResourceType, ScheduleBlock, Setup, TimeWindow } from '@storyscript/contracts';
import type { ScheduleInput, ScheduleShot } from '../../src/schedule/types.ts';

/** Deterministic RFC-4122-shaped test ids (version 4, variant 8). */
export const uid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** UTC instant on the test day. */
export const Z = (hhmm: string, day = '2026-10-05'): string => `${day}T${hhmm}:00.000Z`;

export const win = (start: string, end: string, day = '2026-10-05'): TimeWindow => ({
  start_utc: Z(start, day),
  end_utc: Z(end, day),
});

export function resource(id: string, type: ResourceType, name: string, windows: TimeWindow[], confirmed = true): Resource {
  return { id, type, name, windows, cast_character_ids: [], confirmed };
}

export function setup(
  id: string,
  label: string,
  opts: {
    location?: string | null;
    shots: string[];
    equipment?: string[];
    setup?: number;
    perShot?: number;
    reset?: number;
    confirmed?: boolean;
  },
): Setup {
  return {
    id,
    label,
    location_resource_id: opts.location ?? null,
    shot_ids: opts.shots,
    resource_ids: opts.equipment ?? [],
    durations: { setup_min: opts.setup ?? 0, per_shot_min: opts.perShot ?? 30, reset_min: opts.reset ?? 0 },
    estimate_confirmed: opts.confirmed ?? true,
  };
}

export const shot = (id: string, performers: string[] = [], required: ScheduleShot['required_status'] = 'required'): ScheduleShot => ({
  id,
  required_status: required,
  performer_ids: performers,
});

let constraintSeq = 0x9000;
const cid = (): string => uid(constraintSeq++);

export const before = (a: string, b: string, confirmed = true): Constraint => ({
  id: cid(),
  type: 'before',
  a_setup_id: a,
  b_setup_id: b,
  confirmed,
});
export const notBefore = (setupId: string, at: string, confirmed = true): Constraint => ({
  id: cid(),
  type: 'not_before',
  setup_id: setupId,
  at_utc: at,
  confirmed,
});
export const notAfter = (setupId: string, at: string, confirmed = true): Constraint => ({
  id: cid(),
  type: 'not_after',
  setup_id: setupId,
  at_utc: at,
  confirmed,
});
export const locked = (setupId: string, start: string, end: string, confirmed = true): Constraint => ({
  id: cid(),
  type: 'locked_block',
  setup_id: setupId,
  start_utc: start,
  end_utc: end,
  confirmed,
});

export function input(parts: Partial<ScheduleInput> & Pick<ScheduleInput, 'setups' | 'resources' | 'shots'>): ScheduleInput {
  return {
    date: '2026-10-05',
    timezone: 'UTC',
    crew_window: win('08:00', '20:00'),
    constraints: [],
    ...parts,
  };
}

export const ms = (iso: string): number => Date.parse(iso);
export const blockMinutes = (b: ScheduleBlock): number => (ms(b.end_utc) - ms(b.start_utc)) / 60_000;

/** Test-side overlap check, written independently of core. */
export function overlappingPairs(blocks: readonly ScheduleBlock[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      if (ms(a.start_utc) < ms(b.end_utc) && ms(b.start_utc) < ms(a.end_utc)) out.push([a.id, b.id]);
    }
  }
  return out;
}

/** Test-side window check: some single window of the resource contains the block. */
export function insideSomeWindow(r: Resource, b: ScheduleBlock): boolean {
  return r.windows.some((w) => ms(w.start_utc) <= ms(b.start_utc) && ms(b.end_utc) <= ms(w.end_utc));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
