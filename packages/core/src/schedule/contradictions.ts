import type { Contradiction, Uuid } from '@storyscript/contracts';
import { type Model, type SetupModel, availability, hhmm, resourceNames, setupBound } from './model.ts';
import { type Interval, longestSegment, overlaps, setCovers } from './time.ts';

/**
 * Explicit contradictions: facts in the input that rule out ANY schedule
 * placing every required setup — independent of ordering heuristics. Each
 * check is sound on its own (it never fires when a valid schedule exists),
 * which is what licenses the `proven_infeasible` outcome.
 *
 * Only complete, required setups are considered: an optional setup that
 * cannot fit is simply left unplaced (partial), never "proof" of anything.
 */
export function findContradictions(model: Model): Contradiction[] {
  if (!model.crew) return [];
  const crew = model.crew;
  const out: Contradiction[] = [];
  const subjects = model.setups.filter((s) => s.complete && s.required);

  // NO_WINDOW — a confirmed resource the setup needs has no availability that day.
  const noWindowSetups = new Set<Uuid>();
  const needers = new Map<Uuid, Uuid[]>();
  for (const s of subjects) {
    for (const rid of new Set(s.parts.flatMap((p) => p.resources))) {
      const r = model.resources.get(rid);
      if (!r || !r.confirmed) continue;
      if (availability(model, [rid]).length === 0) {
        needers.set(rid, [...(needers.get(rid) ?? []), s.id]);
        noWindowSetups.add(s.id);
      }
    }
  }
  for (const [rid, setupIds] of [...needers].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push({
      code: 'NO_WINDOW',
      message: `${resourceNames(model, [rid])} is confirmed but has no availability inside the crew window ${hhmm(model, crew.start)}–${hhmm(model, crew.end)}`,
      setup_ids: [...setupIds].sort(),
      resource_ids: [rid],
    });
  }

  // BLOCK_EXCEEDS_WINDOWS — one block is longer than the longest stretch in
  // which all of its resources (and the crew, not_before/not_after) are free.
  for (const s of subjects) {
    if (noWindowSetups.has(s.id) || s.locks.length > 0) continue;
    for (const part of s.parts) {
      const avail = availability(model, part.resources, setupBound(s));
      const longest = longestSegment(avail);
      if (longest < part.duration) {
        out.push({
          code: 'BLOCK_EXCEEDS_WINDOWS',
          message:
            `"${s.label}" ${part.kind} needs ${part.duration / 60_000} min, but the longest common free stretch of ` +
            `${part.resources.length > 0 ? resourceNames(model, part.resources) : 'the crew'}` +
            `${s.notBefore !== null || s.notAfter !== null ? ' within not_before/not_after' : ''} is ${longest / 60_000} min`,
          setup_ids: [s.id],
          resource_ids: [...part.resources],
        });
      }
    }
  }

  out.push(...precedenceCycles(model, subjects));
  out.push(...lockedConflicts(model, subjects));
  return out;
}

/** Strongly connected components (Tarjan) over confirmed `before` edges. */
function precedenceCycles(model: Model, subjects: SetupModel[]): Contradiction[] {
  const ids = new Set(subjects.map((s) => s.id));
  const edges = new Map<Uuid, Uuid[]>();
  const selfLoops = new Set<Uuid>();
  for (const e of model.before) {
    if (!ids.has(e.a) || !ids.has(e.b)) continue;
    if (e.a === e.b) selfLoops.add(e.a);
    edges.set(e.a, [...(edges.get(e.a) ?? []), e.b]);
  }
  let counter = 0;
  const index = new Map<Uuid, number>();
  const low = new Map<Uuid, number>();
  const stack: Uuid[] = [];
  const onStack = new Set<Uuid>();
  const sccs: Uuid[][] = [];
  const strong = (v: Uuid): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of (edges.get(v) ?? []).slice().sort()) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: Uuid[] = [];
      let w: Uuid | undefined;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const s of subjects) if (!index.has(s.id)) strong(s.id);

  return sccs
    .filter((c) => c.length > 1 || selfLoops.has(c[0]!))
    .map((c) => c.slice().sort())
    .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
    .map((c) => ({
      code: 'PRECEDENCE_CYCLE' as const,
      message: `confirmed "before" constraints form a cycle: ${c.map((id) => `"${model.byId.get(id)?.label ?? id}"`).join(' → ')}`,
      setup_ids: c,
      resource_ids: [],
    }));
}

/** Locked setups laid out from their locked start: setup → shoot → reset (+buffer). */
function lockedConflicts(model: Model, subjects: SetupModel[]): Contradiction[] {
  const out: Contradiction[] = [];
  const conflict = (message: string, setupIds: Uuid[], resourceIds: Uuid[] = []): void => {
    out.push({ code: 'LOCKED_CONFLICT', message, setup_ids: [...setupIds].sort(), resource_ids: [...resourceIds].sort() });
  };
  const locked: { s: SetupModel; span: Interval }[] = [];
  for (const s of subjects) {
    if (s.locks.length === 0) continue;
    if (s.locks.length > 1) {
      conflict(`"${s.label}" has ${s.locks.length} different confirmed locked blocks`, [s.id]);
      continue;
    }
    const span = s.locks[0]!;
    locked.push({ s, span });
    const range = `${hhmm(model, span.start)}–${hhmm(model, span.end)}`;
    if (span.end - span.start < s.total) {
      conflict(`"${s.label}" is locked to ${range} (${(span.end - span.start) / 60_000} min) but needs ${s.total / 60_000} min`, [s.id]);
    }
    if (s.notBefore !== null && span.start < s.notBefore) {
      conflict(`"${s.label}" is locked to ${range} but must not start before ${hhmm(model, s.notBefore)}`, [s.id]);
    }
    if (s.notAfter !== null && span.end > s.notAfter) {
      conflict(`"${s.label}" is locked to ${range} but must finish by ${hhmm(model, s.notAfter)}`, [s.id]);
    }
    for (const part of s.parts) {
      const iv = { start: span.start + part.offset, end: span.start + part.offset + part.duration };
      if (!setCovers([model.crew!], iv)) {
        conflict(`"${s.label}" ${part.kind} at ${hhmm(model, iv.start)}–${hhmm(model, iv.end)} falls outside the crew window`, [s.id]);
      }
      const outside = part.resources.filter((rid) => !setCovers(model.resources.get(rid)?.windows ?? [], iv));
      if (outside.length > 0) {
        conflict(
          `"${s.label}" ${part.kind} at ${hhmm(model, iv.start)}–${hhmm(model, iv.end)} falls outside the windows of ${resourceNames(model, outside)}`,
          [s.id],
          outside,
        );
      }
    }
  }
  for (let i = 0; i < locked.length; i++) {
    for (let j = i + 1; j < locked.length; j++) {
      const x = locked[i]!;
      const y = locked[j]!;
      if (overlaps(x.span, y.span)) {
        conflict(`locked blocks of "${x.s.label}" and "${y.s.label}" overlap (single crew)`, [x.s.id, y.s.id]);
      }
    }
  }
  const spanOf = new Map(locked.map((l) => [l.s.id, l.span]));
  for (const e of model.before) {
    const a = spanOf.get(e.a);
    const b = spanOf.get(e.b);
    if (a && b && e.a !== e.b && a.end > b.start) {
      conflict(
        `"${model.byId.get(e.a)?.label}" must come before "${model.byId.get(e.b)?.label}" but both are locked the other way round`,
        [e.a, e.b],
      );
    }
  }
  return out;
}
