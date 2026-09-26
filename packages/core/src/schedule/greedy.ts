import type { ScheduleBlock, Unplaced, Uuid } from '@storyscript/contracts';
import { type Model, type SetupModel, availability, hhmm, resourceNames } from './model.ts';
import { type Interval, overlaps, setCovers, toUtcIso } from './time.ts';

/**
 * Greedy placement (single crew). Locked setups are pinned first; every other
 * setup, in the given order, takes the earliest start that is
 *  - ≥ the cursor (end of the previously placed setup in the order),
 *  - inside the crew window and every resource window of each of its parts,
 *  - within not_before / not_after,
 *  - clear of every block already placed (single crew ⇒ no overlap at all),
 *  - consistent with confirmed `before` constraints against placed setups.
 * A setup's parts run back to back: setup → shoot → reset.
 * Setups that do not fit are reported in `unplaced` with a reason; placement
 * continues with the rest. Failure here never means "proven infeasible".
 */

export interface GreedyResult {
  blocks: ScheduleBlock[];
  unplaced: Unplaced[];
  /** placed setups by start time, then unplaced ones in attempted order */
  order: Uuid[];
}

interface Placed {
  setup: SetupModel;
  start: number;
  end: number;
}

interface SearchOptions {
  lower: number;
  occupied: readonly Interval[];
  precedence: boolean;
}

export function greedy(model: Model, order: readonly Uuid[]): GreedyResult {
  const placed = new Map<Uuid, Placed>();
  const blocks: ScheduleBlock[] = [];
  const unplaced: Unplaced[] = [];
  const attempted: Uuid[] = [];
  const crew = model.crew;

  const occupied: Interval[] = [];
  const occupy = (s: SetupModel, start: number, locked: boolean, spanEnd: number): void => {
    for (const part of s.parts) {
      const iv = { start: start + part.offset, end: start + part.offset + part.duration };
      blocks.push(makeBlock(s, part.kind, iv, part.resources, locked));
      occupied.push(iv);
    }
    if (spanEnd > start + s.total) {
      const iv = { start: start + s.total, end: spanEnd };
      blocks.push(makeBlock(s, 'buffer', iv, [], locked));
      occupied.push(iv);
    }
    placed.set(s.id, { setup: s, start, end: spanEnd });
  };

  // 1. locked setups: required first, then by locked start
  const lockedSetups = model.setups
    .filter((s) => s.locks.length > 0)
    .sort((a, b) => Number(b.required) - Number(a.required) || a.locks[0]!.start - b.locks[0]!.start || cmp(a.id, b.id));
  for (const s of lockedSetups) {
    attempted.push(s.id);
    const why = !crew ? 'MISSING_INPUT: crew window is missing' : lockedProblem(model, s, placed, occupied);
    if (why) unplaced.push({ setup_id: s.id, reason: why });
    else occupy(s, s.locks[0]!.start, true, s.locks[0]!.end);
  }

  // 2. everything else in order, behind a monotonic cursor
  let cursor = crew?.start ?? 0;
  for (const id of order) {
    const s = model.byId.get(id);
    if (!s || s.locks.length > 0 || placed.has(id)) continue;
    attempted.push(id);
    if (!crew) {
      unplaced.push({ setup_id: id, reason: 'MISSING_INPUT: crew window is missing' });
      continue;
    }
    if (!s.complete) {
      unplaced.push({ setup_id: id, reason: 'MISSING_INPUT: setup has incomplete data' });
      continue;
    }
    if (selfPrecedence(model, s)) {
      unplaced.push({ setup_id: id, reason: SELF_PRECEDENCE });
      continue;
    }
    const start = earliestStart(model, s, placed, { lower: cursor, occupied, precedence: true });
    if (start === null) {
      unplaced.push({ setup_id: id, reason: diagnose(model, s, placed, occupied, cursor) });
      continue;
    }
    occupy(s, start, false, start + s.total);
    cursor = start + s.total;
  }

  blocks.sort((a, b) => cmp(a.start_utc, b.start_utc) || cmp(a.id, b.id));
  const placedOrder = [...placed.values()].sort((a, b) => a.start - b.start || cmp(a.setup.id, b.setup.id)).map((p) => p.setup.id);
  const unplacedIds = new Set(unplaced.map((u) => u.setup_id));
  return {
    blocks,
    unplaced,
    order: [...placedOrder, ...attempted.filter((id) => unplacedIds.has(id))],
  };
}

const SELF_PRECEDENCE = 'PRECEDENCE: a confirmed "before" constraint points this setup at itself';

function selfPrecedence(model: Model, s: SetupModel): boolean {
  return model.before.some((e) => e.a === s.id && e.b === s.id);
}

function makeBlock(
  s: SetupModel,
  kind: ScheduleBlock['kind'],
  iv: Interval,
  resources: readonly Uuid[],
  locked: boolean,
): ScheduleBlock {
  return {
    id: `${s.id}:${kind}`,
    kind,
    setup_id: s.id,
    shot_ids: kind === 'shoot' ? [...s.shotIds] : [],
    resource_ids: [...resources],
    start_utc: toUtcIso(iv.start),
    end_utc: toUtcIso(iv.end),
    locked,
  };
}

/** Why a locked setup cannot sit at its locked span (null when it can). */
function lockedProblem(model: Model, s: SetupModel, placed: Map<Uuid, Placed>, occupied: Interval[]): string | null {
  if (!s.complete) return 'MISSING_INPUT: setup has incomplete data';
  if (s.locks.length > 1) return 'LOCKED: several different locked blocks are confirmed for this setup';
  if (selfPrecedence(model, s)) return SELF_PRECEDENCE;
  const span = s.locks[0]!;
  const range = `${hhmm(model, span.start)}–${hhmm(model, span.end)}`;
  if (span.end - span.start < s.total) return `LOCKED: locked span ${range} is shorter than the setup's ${s.total / 60_000} min`;
  if (s.notBefore !== null && span.start < s.notBefore) return `LOCKED: locked span ${range} starts before its not_before`;
  if (s.notAfter !== null && span.end > s.notAfter) return `LOCKED: locked span ${range} ends after its not_after`;
  if (!setCovers([model.crew!], span)) return `LOCKED: locked span ${range} is outside the crew window`;
  for (const part of s.parts) {
    const iv = { start: span.start + part.offset, end: span.start + part.offset + part.duration };
    const avail = availability(model, part.resources);
    if (!setCovers(avail, iv)) {
      return `LOCKED: ${part.kind} at ${hhmm(model, iv.start)}–${hhmm(model, iv.end)} is outside the windows of ${resourceNames(model, part.resources)}`;
    }
  }
  const clash = occupied.find((o) => overlaps(o, span));
  if (clash) return `LOCKED: locked span ${range} overlaps another locked setup`;
  const prec = precedenceBounds(model, s, placed);
  if (span.start < prec.lower || span.end > prec.upper) return `PRECEDENCE: locked span ${range} breaks a "before" constraint`;
  return null;
}

/** Bounds implied by confirmed `before` constraints against already placed setups. */
function precedenceBounds(model: Model, s: SetupModel, placed: Map<Uuid, Placed>): { lower: number; upper: number; blockers: Uuid[] } {
  let lower = -Infinity;
  let upper = Infinity;
  const blockers: Uuid[] = [];
  for (const e of model.before) {
    if (e.b === s.id && e.a !== s.id) {
      const p = placed.get(e.a);
      if (p) {
        lower = Math.max(lower, p.end);
        blockers.push(e.a);
      }
    }
    if (e.a === s.id && e.b !== s.id) {
      const p = placed.get(e.b);
      if (p) {
        upper = Math.min(upper, p.start);
        blockers.push(e.b);
      }
    }
  }
  return { lower, upper, blockers };
}

/**
 * Earliest feasible start, or null. The feasible set of starts is a finite
 * union of closed intervals whose left endpoints are all among the candidate
 * points below, so testing candidates in ascending order is exact.
 */
function earliestStart(model: Model, s: SetupModel, placed: Map<Uuid, Placed>, opt: SearchOptions): number | null {
  const crew = model.crew!;
  const avail = s.parts.map((p) => availability(model, p.resources));
  const prec = opt.precedence ? precedenceBounds(model, s, placed) : { lower: -Infinity, upper: Infinity };
  const lower = Math.max(opt.lower, crew.start, s.notBefore ?? -Infinity, prec.lower);
  const latestEnd = Math.min(crew.end, s.notAfter ?? Infinity, prec.upper);
  const tMax = latestEnd - s.total;
  if (lower > tMax) return null;

  const candidates = new Set<number>([lower]);
  s.parts.forEach((part, i) => {
    for (const w of avail[i]!) candidates.add(w.start - part.offset);
  });
  for (const o of opt.occupied) candidates.add(o.end);
  const sorted = [...candidates].filter((t) => t >= lower && t <= tMax).sort((a, b) => a - b);

  for (const t of sorted) {
    const fits = s.parts.every((part, i) =>
      setCovers(avail[i]!, { start: t + part.offset, end: t + part.offset + part.duration }),
    );
    if (!fits) continue;
    const span = { start: t, end: t + s.total };
    if (opt.occupied.some((o) => overlaps(o, span))) continue;
    return t;
  }
  return null;
}

/** Explains a failed placement by relaxing constraints one tier at a time. */
function diagnose(model: Model, s: SetupModel, placed: Map<Uuid, Placed>, occupied: Interval[], cursor: number): string {
  const crew = model.crew!;
  if (earliestStart(model, s, placed, { lower: crew.start, occupied: [], precedence: false }) === null) {
    return (
      `NO_SLOT: no start time lets setup → shoot → reset (${s.total / 60_000} min) run back to back inside the windows of ` +
      `${resourceNames(model, [...new Set(s.parts.flatMap((p) => p.resources))])}, the crew window` +
      `${s.notBefore !== null || s.notAfter !== null ? ' and its not_before/not_after' : ''}`
    );
  }
  if (earliestStart(model, s, placed, { lower: crew.start, occupied: [], precedence: true }) === null) {
    const { blockers } = precedenceBounds(model, s, placed);
    const names = blockers.map((id) => `"${model.byId.get(id)?.label ?? id}"`).join(', ');
    return `PRECEDENCE: a confirmed "before" constraint with already placed ${names} leaves no room`;
  }
  if (earliestStart(model, s, placed, { lower: crew.start, occupied, precedence: true }) === null) {
    return 'OCCUPIED: every slot that fits its windows is already taken by setups placed earlier';
  }
  return `ORDER: it only fits before ${hhmm(model, cursor)}, where the previous setup in the order ends; move it earlier in the order`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
