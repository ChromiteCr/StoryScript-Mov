import type { BlockKind, Constraint, Resource, ResourceType, Setup, Uuid, Violation } from '@storyscript/contracts';
import type { ScheduleInput, ScheduleShot } from './types.ts';
import {
  type Interval,
  intersectSets,
  isValidTimeZone,
  mergeIntervals,
  minutesToMs,
  parseUtc,
  utcToLocal,
  windowToInterval,
} from './time.ts';

/**
 * Normalised planning model shared by grouping, contradiction search and the
 * greedy placer. The validator deliberately does NOT use this module: it
 * re-derives everything from the raw ScheduleInput.
 */

export interface ResourceModel {
  id: Uuid;
  type: ResourceType;
  name: string;
  confirmed: boolean;
  /** merged availability, not yet clipped to the crew window */
  windows: Interval[];
}

export interface SubBlockSpec {
  kind: BlockKind;
  /** offset from the setup's start, ms */
  offset: number;
  duration: number;
  resources: Uuid[];
}

export interface SetupModel {
  id: Uuid;
  label: string;
  location: Uuid | null;
  equipment: Uuid[];
  performers: Uuid[];
  /** non-waived shots, in setup order */
  shotIds: Uuid[];
  /** at least one active shot is `required` */
  required: boolean;
  estimateConfirmed: boolean;
  /** contiguous setup → shoot → reset layout (zero-length parts omitted) */
  parts: SubBlockSpec[];
  total: number;
  notBefore: number | null;
  notAfter: number | null;
  /** distinct spans from confirmed locked_block constraints */
  locks: Interval[];
  /** false when this setup has MISSING_INPUT issues */
  complete: boolean;
}

export interface Precedence {
  id: Uuid;
  a: Uuid;
  b: Uuid;
}

export interface Model {
  timezone: string;
  crew: Interval | null;
  /** active setups (≥1 non-waived shot), sorted by id */
  setups: SetupModel[];
  byId: Map<Uuid, SetupModel>;
  resources: Map<Uuid, ResourceModel>;
  /** confirmed `before` constraints whose both ends are active setups */
  before: Precedence[];
  /** MISSING_INPUT findings → outcome needs_input */
  issues: Violation[];
}

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(cmpStr);

/**
 * Canonical copy of the input: known fields only, id-keyed collections sorted
 * by id, order-insensitive inner arrays sorted. Scheduling is a function of
 * this value alone, so array order in the caller's input never matters and
 * `planInputHash` is stable.
 */
export function normalizeScheduleInput(input: ScheduleInput): ScheduleInput {
  const setups: Setup[] = input.setups
    .map((s) => ({
      id: s.id,
      location_resource_id: s.location_resource_id,
      label: s.label,
      shot_ids: [...s.shot_ids],
      resource_ids: sortedUnique(s.resource_ids),
      durations: {
        setup_min: s.durations.setup_min,
        per_shot_min: s.durations.per_shot_min,
        reset_min: s.durations.reset_min,
      },
      estimate_confirmed: s.estimate_confirmed,
    }))
    .sort(byId);
  const resources: Resource[] = input.resources
    .map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      windows: r.windows
        .map((w) => ({ start_utc: w.start_utc, end_utc: w.end_utc }))
        .sort((a, b) => cmpStr(a.start_utc, b.start_utc) || cmpStr(a.end_utc, b.end_utc)),
      cast_character_ids: sortedUnique(r.cast_character_ids),
      confirmed: r.confirmed,
    }))
    .sort(byId);
  const shots: ScheduleShot[] = input.shots
    .map((s) => ({ id: s.id, required_status: s.required_status, performer_ids: sortedUnique(s.performer_ids) }))
    .sort(byId);
  const constraints: Constraint[] = input.constraints.map((c) => ({ ...c })).sort(byId);
  const out: ScheduleInput = {
    date: input.date,
    timezone: input.timezone,
    crew_window: { start_utc: input.crew_window.start_utc, end_utc: input.crew_window.end_utc },
    setups,
    resources,
    shots,
    constraints,
  };
  if (input.order_override) out.order_override = [...input.order_override];
  return out;
}

function issue(message: string, ref: Partial<Pick<Violation, 'setup_id' | 'resource_id' | 'shot_id'>> = {}): Violation {
  return {
    code: 'MISSING_INPUT',
    message,
    block_id: null,
    setup_id: ref.setup_id ?? null,
    resource_id: ref.resource_id ?? null,
    shot_id: ref.shot_id ?? null,
  };
}

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup].sort(cmpStr);
}

/** Builds the planning model from a normalised input. */
export function analyze(norm: ScheduleInput): Model {
  const issues: Violation[] = [];

  const tzOk = isValidTimeZone(norm.timezone);
  if (!tzOk) issues.push(issue(`unknown time zone "${norm.timezone}"`));

  const crewIv = windowToInterval(norm.crew_window);
  const crew = Number.isFinite(crewIv.start) && Number.isFinite(crewIv.end) && crewIv.start < crewIv.end ? crewIv : null;
  if (!crew) issues.push(issue('crew window is missing, malformed or empty'));

  for (const id of findDuplicates(norm.setups.map((s) => s.id))) issues.push(issue(`duplicate setup id ${id}`, { setup_id: id }));
  for (const id of findDuplicates(norm.resources.map((r) => r.id))) issues.push(issue(`duplicate resource id ${id}`, { resource_id: id }));
  for (const id of findDuplicates(norm.shots.map((s) => s.id))) issues.push(issue(`duplicate shot id ${id}`, { shot_id: id }));

  const resources = new Map<Uuid, ResourceModel>();
  const badWindows = new Set<Uuid>();
  for (const r of norm.resources) {
    const ivs = r.windows.map(windowToInterval);
    if (ivs.some((iv) => !(Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.start < iv.end))) badWindows.add(r.id);
    if (!resources.has(r.id)) {
      resources.set(r.id, { id: r.id, type: r.type, name: r.name, confirmed: r.confirmed, windows: mergeIntervals(ivs) });
    }
  }
  const shots = new Map<Uuid, ScheduleShot>();
  for (const s of norm.shots) if (!shots.has(s.id)) shots.set(s.id, s);

  const activeIds = new Set<Uuid>();
  for (const s of norm.setups) {
    if (s.shot_ids.some((id) => shots.get(id)?.required_status !== 'waived')) activeIds.add(s.id);
  }

  // constraints: only confirmed ones participate
  const notBefore = new Map<Uuid, number>();
  const notAfter = new Map<Uuid, number>();
  const locks = new Map<Uuid, Interval[]>();
  const before: Precedence[] = [];
  const knownSetup = new Set(norm.setups.map((s) => s.id));
  for (const c of norm.constraints) {
    if (!c.confirmed) continue;
    const refs = c.type === 'before' ? [c.a_setup_id, c.b_setup_id] : [c.setup_id];
    const unknown = refs.filter((id) => !knownSetup.has(id));
    if (unknown.length > 0) {
      issues.push(issue(`constraint ${c.id} (${c.type}) references unknown setup ${unknown.join(', ')}`));
      continue;
    }
    if (!refs.every((id) => activeIds.has(id))) continue; // nothing left to shoot in that setup
    switch (c.type) {
      case 'before':
        before.push({ id: c.id, a: c.a_setup_id, b: c.b_setup_id });
        break;
      case 'not_before': {
        const at = parseUtc(c.at_utc);
        if (!Number.isFinite(at)) issues.push(issue(`constraint ${c.id} has a malformed time`, { setup_id: c.setup_id }));
        else notBefore.set(c.setup_id, Math.max(notBefore.get(c.setup_id) ?? -Infinity, at));
        break;
      }
      case 'not_after': {
        const at = parseUtc(c.at_utc);
        if (!Number.isFinite(at)) issues.push(issue(`constraint ${c.id} has a malformed time`, { setup_id: c.setup_id }));
        else notAfter.set(c.setup_id, Math.min(notAfter.get(c.setup_id) ?? Infinity, at));
        break;
      }
      case 'locked_block': {
        const iv = { start: parseUtc(c.start_utc), end: parseUtc(c.end_utc) };
        if (!(Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.start < iv.end)) {
          issues.push(issue(`locked block ${c.id} has a malformed or empty span`, { setup_id: c.setup_id }));
          break;
        }
        const list = locks.get(c.setup_id) ?? [];
        if (!list.some((l) => l.start === iv.start && l.end === iv.end)) list.push(iv);
        locks.set(c.setup_id, list);
        break;
      }
    }
  }

  const setups: SetupModel[] = [];
  for (const s of norm.setups) {
    if (!activeIds.has(s.id)) continue;
    if (setups.some((x) => x.id === s.id)) continue; // duplicate id already reported
    let complete = true;
    const fail = (message: string, ref: Parameters<typeof issue>[1] = {}): void => {
      complete = false;
      issues.push(issue(message, { setup_id: s.id, ...ref }));
    };

    const activeShots: ScheduleShot[] = [];
    for (const shotId of s.shot_ids) {
      const shot = shots.get(shotId);
      if (!shot) fail(`setup "${s.label}" references unknown shot ${shotId}`, { shot_id: shotId });
      else if (shot.required_status !== 'waived' && !activeShots.includes(shot)) activeShots.push(shot);
    }
    const location = s.location_resource_id;
    const equipment = sortedUnique(s.resource_ids.filter((id) => id !== location));
    const performers = sortedUnique(activeShots.flatMap((sh) => sh.performer_ids));
    const referenced = sortedUnique([...(location ? [location] : []), ...equipment, ...performers]);
    for (const rid of referenced) {
      const r = resources.get(rid);
      if (!r) fail(`setup "${s.label}" needs unknown resource ${rid}`, { resource_id: rid });
      else if (badWindows.has(rid)) fail(`resource "${r.name}" has a malformed or empty time window`, { resource_id: rid });
      else if (!r.confirmed && r.windows.length === 0) {
        fail(`resource "${r.name}" is unconfirmed and has no time window`, { resource_id: rid });
      }
    }

    const d = s.durations;
    const nums = [d.setup_min, d.per_shot_min, d.reset_min];
    const setupMs = minutesToMs(d.setup_min);
    const shootMs = minutesToMs(d.per_shot_min) * activeShots.length;
    const resetMs = minutesToMs(d.reset_min);
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
      fail(`setup "${s.label}" has invalid durations`);
    } else if (activeShots.length > 0 && shootMs <= 0) {
      fail(`setup "${s.label}" has no per-shot duration`);
    }

    const locSet = location ? [location] : [];
    const parts: SubBlockSpec[] = [];
    let offset = 0;
    for (const [kind, duration, res] of [
      ['setup', setupMs, sortedUnique([...locSet, ...equipment])],
      ['shoot', shootMs, referenced],
      ['reset', resetMs, sortedUnique([...locSet, ...equipment])],
    ] as const) {
      if (duration > 0) parts.push({ kind, offset, duration, resources: [...res] });
      offset += Math.max(0, duration);
    }

    setups.push({
      id: s.id,
      label: s.label,
      location,
      equipment,
      performers,
      shotIds: activeShots.map((sh) => sh.id),
      required: activeShots.some((sh) => sh.required_status === 'required'),
      estimateConfirmed: s.estimate_confirmed,
      parts,
      total: offset,
      notBefore: notBefore.get(s.id) ?? null,
      notAfter: notAfter.get(s.id) ?? null,
      locks: (locks.get(s.id) ?? []).slice().sort((a, b) => a.start - b.start || a.end - b.end),
      complete,
    });
  }

  return {
    timezone: tzOk ? norm.timezone : 'UTC',
    crew,
    setups,
    byId: new Map(setups.map((s) => [s.id, s])),
    resources,
    before,
    issues,
  };
}

/** Availability of a resource set inside the crew window (unknown resources → none). */
export function availability(model: Model, resourceIds: readonly Uuid[], bound?: Interval): Interval[] {
  if (!model.crew) return [];
  let set: Interval[] = [model.crew];
  if (bound) set = intersectSets(set, [bound]);
  for (const rid of resourceIds) {
    const r = model.resources.get(rid);
    if (!r) return [];
    set = intersectSets(set, r.windows);
    if (set.length === 0) return set;
  }
  return set;
}

/** [not_before, not_after) bound of a setup (unbounded sides → ±Infinity). */
export function setupBound(s: SetupModel): Interval {
  return { start: s.notBefore ?? -Infinity, end: s.notAfter ?? Infinity };
}

export function resourceNames(model: Model, ids: readonly Uuid[]): string {
  return ids.map((id) => `"${model.resources.get(id)?.name ?? id}"`).join(', ');
}

/** Human-readable local HH:mm for reasons/messages. */
export function hhmm(model: Model, ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  return utcToLocal(ms, model.timezone).time;
}
