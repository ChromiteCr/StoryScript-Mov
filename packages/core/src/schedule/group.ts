import type { Uuid } from '@storyscript/contracts';
import { type Model, type SetupModel, availability, setupBound } from './model.ts';

/**
 * Default shooting order (heuristic, deterministic):
 *  1. setups sharing a location stay adjacent (one company move per location);
 *  2. tighter first — the setup whose common resource window ends earliest
 *     leads, and a location group is ranked by its tightest member;
 *  3. confirmed `before` constraints are honoured by a priority topological
 *     sort that stays as close as possible to the order from 1–2;
 *  4. ties break on label, then id (code-unit comparison, locale-free).
 */
export function defaultOrder(model: Model): Uuid[] {
  const deadline = new Map<Uuid, number>();
  for (const s of model.setups) deadline.set(s.id, windowEnd(model, s));

  const cmpSetup = (a: SetupModel, b: SetupModel): number =>
    deadline.get(a.id)! - deadline.get(b.id)! || cmpStr(a.label, b.label) || cmpStr(a.id, b.id);

  const groups = new Map<string, SetupModel[]>();
  for (const s of model.setups) {
    const key = s.location ?? `solo:${s.id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const ranked = [...groups.values()].map((members) => members.slice().sort(cmpSetup));
  ranked.sort((a, b) => cmpSetup(a[0]!, b[0]!));
  const preferred = ranked.flat().map((s) => s.id);
  return topoByPriority(model, preferred);
}

/**
 * Alternative starting orders for multi-start greedy. Each respects confirmed
 * `before` constraints; duplicates are removed. Order matters only as a
 * deterministic tie-break when two candidates score the same.
 *  - grouped: the default (location groups ranked by tightest member)
 *  - tightest: tightest common window first, ignoring location grouping
 *  - earliest: earliest not_before / lock first, then tightest
 *  - required: required setups before optional ones, each in default order
 */
export function candidateOrders(model: Model): Uuid[][] {
  const deadline = new Map<Uuid, number>();
  for (const s of model.setups) deadline.set(s.id, windowEnd(model, s));
  const byDeadline = (a: SetupModel, b: SetupModel): number =>
    deadline.get(a.id)! - deadline.get(b.id)! || cmpStr(a.label, b.label) || cmpStr(a.id, b.id);
  const earliestOf = (s: SetupModel): number => s.locks[0]?.start ?? s.notBefore ?? Number.NEGATIVE_INFINITY;

  const grouped = defaultOrder(model);
  const tightest = topoByPriority(model, model.setups.slice().sort(byDeadline).map((s) => s.id));
  const earliest = topoByPriority(
    model,
    model.setups
      .slice()
      .sort((a, b) => earliestOf(a) - earliestOf(b) || byDeadline(a, b))
      .map((s) => s.id),
  );
  const rank = new Map(grouped.map((id, i) => [id, i]));
  const required = topoByPriority(
    model,
    model.setups
      .slice()
      .sort((a, b) => Number(b.required) - Number(a.required) || rank.get(a.id)! - rank.get(b.id)!)
      .map((s) => s.id),
  );

  const seen = new Set<string>();
  const out: Uuid[][] = [];
  for (const order of [grouped, tightest, earliest, required]) {
    const key = order.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(order);
    }
  }
  return out;
}

/**
 * Resolves the order greedy will follow: an explicit order (manual move or an
 * adopted LLM suggestion) is kept as given — unknown and duplicate ids are
 * dropped, active setups it leaves out are appended in default order.
 */
export function resolveOrder(model: Model, requested?: readonly Uuid[]): Uuid[] {
  const base = defaultOrder(model);
  if (!requested) return base;
  const seen = new Set<Uuid>();
  const out: Uuid[] = [];
  for (const id of requested) {
    if (model.byId.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of base) if (!seen.has(id)) out.push(id);
  return out;
}

/** Latest instant at which the setup's resources are all still available together. */
function windowEnd(model: Model, s: SetupModel): number {
  if (s.locks[0]) return s.locks[0].end;
  const shoot = s.parts.find((p) => p.kind === 'shoot');
  const avail = availability(model, shoot?.resources ?? [], setupBound(s));
  const last = avail[avail.length - 1];
  return last ? last.end : (model.crew?.start ?? 0);
}

function topoByPriority(model: Model, preferred: Uuid[]): Uuid[] {
  const rank = new Map(preferred.map((id, i) => [id, i]));
  const preds = new Map<Uuid, Set<Uuid>>(preferred.map((id) => [id, new Set<Uuid>()]));
  for (const e of model.before) {
    if (e.a !== e.b && rank.has(e.a) && rank.has(e.b)) preds.get(e.b)!.add(e.a);
  }
  const done = new Set<Uuid>();
  const out: Uuid[] = [];
  for (;;) {
    const next = preferred.find((id) => !done.has(id) && [...preds.get(id)!].every((p) => done.has(p)));
    if (next === undefined) break;
    done.add(next);
    out.push(next);
  }
  // members of a cycle (only possible among optional setups) keep preferred order
  for (const id of preferred) if (!done.has(id)) out.push(id);
  return out;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
