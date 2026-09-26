import type { ScheduleBlock, ScheduleResult, Setup, Uuid, Violation, ViolationCode } from '@storyscript/contracts';
import type { ScheduleInput } from './types.ts';

/**
 * Independent schedule validator (SPEC FR-06 step 5).
 *
 * Written separately from the greedy placer on purpose: it shares no
 * interval code with it and re-derives, from the raw input, which resources
 * every block really occupies (a block cannot hide a performer by leaving it
 * out of `resource_ids`). Checks:
 *   CREW_OVERLAP       any two blocks overlap in time (single crew)
 *   RESOURCE_OVERLAP   two overlapping blocks share a resource
 *   OUTSIDE_WINDOW     a block is not fully covered by the crew window or by
 *                      the windows of every resource it occupies
 *   PRECEDENCE         confirmed `before`: all of A ends before any of B starts
 *   NOT_BEFORE         confirmed `not_before`: the setup's first block starts at/after it
 *   NOT_AFTER          confirmed `not_after`: the setup's last block ends at/before it
 *   LOCKED_BLOCK_MOVED confirmed `locked_block`: blocks start at the locked
 *                      start and stay inside the locked span
 *   UNPLACED_REQUIRED  a required (non-waived) shot of a setup has no shoot block
 * Unconfirmed constraints are drafts and are ignored.
 */
export function validate(input: ScheduleInput, blocks: readonly ScheduleBlock[]): Violation[] {
  const out: Violation[] = [];
  const push = (code: ViolationCode, message: string, ref: Ref = {}): void => {
    out.push({
      code,
      message,
      block_id: ref.block ?? null,
      setup_id: ref.setup ?? null,
      resource_id: ref.resource ?? null,
      shot_id: ref.shot ?? null,
    });
  };

  const setups = new Map<Uuid, Setup>();
  for (const s of input.setups) if (!setups.has(s.id)) setups.set(s.id, s);
  const shots = new Map(input.shots.map((s) => [s.id, s] as const));
  const resources = new Map(input.resources.map((r) => [r.id, r] as const));
  const crewStart = ms(input.crew_window.start_utc);
  const crewEnd = ms(input.crew_window.end_utc);

  // Per block: interval + every resource it really occupies.
  const spans = blocks.map((b) => {
    const start = ms(b.start_utc);
    const end = ms(b.end_utc);
    const occupied = new Set<Uuid>(b.resource_ids);
    const setup = b.setup_id ? setups.get(b.setup_id) : undefined;
    if (setup && b.kind !== 'buffer') {
      if (setup.location_resource_id) occupied.add(setup.location_resource_id);
      for (const r of setup.resource_ids) occupied.add(r);
      if (b.kind === 'shoot') {
        for (const shotId of [...setup.shot_ids, ...b.shot_ids]) {
          const shot = shots.get(shotId);
          if (shot && shot.required_status !== 'waived') for (const p of shot.performer_ids) occupied.add(p);
        }
      }
    }
    return { b, start, end, occupied: [...occupied].sort() };
  });

  // OUTSIDE_WINDOW
  for (const x of spans) {
    const ref = { block: x.b.id, setup: x.b.setup_id };
    if (!(x.start < x.end)) {
      push('OUTSIDE_WINDOW', `block ${x.b.id} has an empty or malformed interval`, ref);
      continue;
    }
    if (!(crewStart <= x.start && x.end <= crewEnd)) {
      push('OUTSIDE_WINDOW', `block ${x.b.id} is not inside the crew window`, ref);
    }
    for (const rid of x.occupied) {
      const r = resources.get(rid);
      const windows = r ? r.windows.map((w) => [ms(w.start_utc), ms(w.end_utc)] as const) : [];
      if (!coveredBy(windows, x.start, x.end)) {
        push('OUTSIDE_WINDOW', `block ${x.b.id} is outside the availability of ${r ? `"${r.name}"` : `unknown resource ${rid}`}`, {
          ...ref,
          resource: rid,
        });
      }
    }
  }

  // CREW_OVERLAP / RESOURCE_OVERLAP (pairwise, stable order)
  const ordered = spans
    .filter((x) => x.start < x.end)
    .sort((p, q) => p.start - q.start || (p.b.id < q.b.id ? -1 : p.b.id > q.b.id ? 1 : 0));
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const p = ordered[i]!;
      const q = ordered[j]!;
      if (q.start >= p.end) continue;
      push('CREW_OVERLAP', `blocks ${p.b.id} and ${q.b.id} overlap; a single crew cannot do both`, {
        block: q.b.id,
        setup: q.b.setup_id,
      });
      for (const rid of q.occupied) {
        if (p.occupied.includes(rid)) {
          push('RESOURCE_OVERLAP', `resource ${rid} is booked by both ${p.b.id} and ${q.b.id}`, {
            block: q.b.id,
            setup: q.b.setup_id,
            resource: rid,
          });
        }
      }
    }
  }

  // Per-setup extent (first start, last end)
  const extent = new Map<Uuid, { start: number; end: number }>();
  for (const x of spans) {
    if (!x.b.setup_id || !(x.start < x.end)) continue;
    const e = extent.get(x.b.setup_id);
    extent.set(x.b.setup_id, e ? { start: Math.min(e.start, x.start), end: Math.max(e.end, x.end) } : { start: x.start, end: x.end });
  }

  for (const c of input.constraints) {
    if (!c.confirmed) continue;
    switch (c.type) {
      case 'before': {
        const a = extent.get(c.a_setup_id);
        const b = extent.get(c.b_setup_id);
        if (a && b && a.end > b.start) {
          push('PRECEDENCE', `setup ${c.a_setup_id} must finish before setup ${c.b_setup_id} starts`, { setup: c.b_setup_id });
        }
        break;
      }
      case 'not_before': {
        const e = extent.get(c.setup_id);
        if (e && e.start < ms(c.at_utc)) push('NOT_BEFORE', `setup ${c.setup_id} starts before ${c.at_utc}`, { setup: c.setup_id });
        break;
      }
      case 'not_after': {
        const e = extent.get(c.setup_id);
        if (e && e.end > ms(c.at_utc)) push('NOT_AFTER', `setup ${c.setup_id} ends after ${c.at_utc}`, { setup: c.setup_id });
        break;
      }
      case 'locked_block': {
        const e = extent.get(c.setup_id);
        if (e && (e.start !== ms(c.start_utc) || e.end > ms(c.end_utc))) {
          push('LOCKED_BLOCK_MOVED', `setup ${c.setup_id} no longer sits at its locked block ${c.start_utc}–${c.end_utc}`, {
            setup: c.setup_id,
          });
        }
        break;
      }
    }
  }

  // UNPLACED_REQUIRED
  const shotInBlock = new Set<Uuid>();
  for (const x of spans) if (x.b.kind === 'shoot' && x.start < x.end) for (const id of x.b.shot_ids) shotInBlock.add(id);
  const reported = new Set<Uuid>();
  for (const s of [...setups.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const shotId of s.shot_ids) {
      const shot = shots.get(shotId);
      if (!shot || shot.required_status !== 'required' || shotInBlock.has(shotId) || reported.has(shotId)) continue;
      reported.add(shotId);
      push('UNPLACED_REQUIRED', `required shot ${shotId} of setup "${s.label}" is not scheduled`, { setup: s.id, shot: shotId });
    }
  }

  return out;
}

/**
 * Violations that block approval beyond `validate` (INV-05): unconfirmed
 * duration estimates, unconfirmed resources, and missing data.
 */
export function approvalBlockers(input: ScheduleInput, result: ScheduleResult): Violation[] {
  const out = validate(input, result.blocks);
  const add = (code: ViolationCode, message: string, ref: Ref = {}): void => {
    const v: Violation = {
      code,
      message,
      block_id: null,
      setup_id: ref.setup ?? null,
      resource_id: ref.resource ?? null,
      shot_id: ref.shot ?? null,
    };
    if (!out.some((o) => o.code === v.code && o.setup_id === v.setup_id && o.resource_id === v.resource_id && o.shot_id === v.shot_id)) {
      out.push(v);
    }
  };
  const shots = new Map(input.shots.map((s) => [s.id, s] as const));
  const resources = new Map(input.resources.map((r) => [r.id, r] as const));
  for (const s of [...input.setups].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const active = s.shot_ids.filter((id) => shots.get(id)?.required_status !== 'waived');
    if (active.length === 0) continue;
    if (!s.estimate_confirmed) add('ESTIMATE_UNCONFIRMED', `durations of setup "${s.label}" are still estimates`, { setup: s.id });
    const needed = new Set<Uuid>([...(s.location_resource_id ? [s.location_resource_id] : []), ...s.resource_ids]);
    for (const id of active) {
      const shot = shots.get(id);
      if (!shot) add('MISSING_INPUT', `setup "${s.label}" references unknown shot ${id}`, { setup: s.id, shot: id });
      else for (const p of shot.performer_ids) needed.add(p);
    }
    for (const rid of [...needed].sort()) {
      const r = resources.get(rid);
      if (!r) add('MISSING_INPUT', `setup "${s.label}" needs unknown resource ${rid}`, { setup: s.id, resource: rid });
      else if (!r.confirmed) add('MISSING_INPUT', `resource "${r.name}" is not confirmed`, { resource: rid });
    }
  }
  for (const v of result.violations) if (v.code === 'MISSING_INPUT') add(v.code, v.message, { setup: v.setup_id, resource: v.resource_id, shot: v.shot_id });
  return out;
}

interface Ref {
  block?: string | null;
  setup?: Uuid | null;
  resource?: Uuid | null;
  shot?: Uuid | null;
}

function ms(iso: string): number {
  return typeof iso === 'string' && iso.endsWith('Z') ? Date.parse(iso) : Number.NaN;
}

/** Does the union of [start,end) windows cover [from,to) without a gap? */
function coveredBy(windows: readonly (readonly [number, number])[], from: number, to: number): boolean {
  const sorted = windows.filter(([a, b]) => a < b).slice().sort((p, q) => p[0] - q[0]);
  let reach = from;
  for (const [a, b] of sorted) {
    if (reach >= to) break;
    if (a > reach) break;
    if (b > reach) reach = b;
  }
  return reach >= to;
}
