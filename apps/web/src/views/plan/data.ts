import { useMemo } from 'react';
import type { Constraint, Entity, Project, Resource, Scene, Setup, Shot, TimeWindow } from '@storyscript/contracts';
import { localWindowToUtc, utcToLocal } from '@storyscript/core';
import type { NameLookup } from '../../lib/labels-plan.ts';
import { useConstraints, useCurrentScript, useEntities, useResources, useSetups, useShots } from '../../lib/queries-plan.ts';

/** Everything the plan page reads besides the plan itself, loaded together. */
export interface PlanData {
  project: Project;
  resources: Resource[];
  setups: Setup[];
  constraints: Constraint[];
  entities: Entity[];
  /** non-archived shots, narrative order */
  shots: Shot[];
  scenes: Scene[];
  names: NameLookup;
  shotById: Map<string, Shot>;
  setupById: Map<string, Setup>;
  resourceById: Map<string, Resource>;
  sceneNo: (sceneId: string) => string;
}

export function usePlanData(project: Project) {
  const resources = useResources();
  const setups = useSetups();
  const constraints = useConstraints();
  const entities = useEntities();
  const shots = useShots();
  const script = useCurrentScript();
  const queries = [resources, setups, constraints, entities, shots, script];
  const pending = queries.some((q) => q.isPending);
  const error = queries.find((q) => q.isError)?.error ?? null;

  const data = useMemo<PlanData | null>(() => {
    if (!resources.data || !setups.data || !constraints.data || !entities.data || !shots.data || script.data === undefined) return null;
    const scenes = script.data?.scenes ?? [];
    const sceneNos = new Map(scenes.map((s) => [s.id, s.display_no]));
    const shotById = new Map(shots.data.map((s) => [s.id, s]));
    const setupById = new Map(setups.data.map((s) => [s.id, s]));
    const resourceById = new Map(resources.data.map((r) => [r.id, r]));
    const sceneNo = (id: string) => sceneNos.get(id) ?? '?';
    const names: NameLookup = {
      setup: (id) => (id ? setupById.get(id) : undefined),
      resource: (id) => (id ? resourceById.get(id) : undefined),
      shot: (id) => (id ? shotById.get(id) : undefined),
      sceneNo: (s) => sceneNo(s.scene_id),
    };
    return {
      project,
      resources: resources.data,
      setups: setups.data,
      constraints: constraints.data,
      entities: entities.data,
      shots: shots.data,
      scenes,
      names,
      shotById,
      setupById,
      resourceById,
      sceneNo,
    };
  }, [project, resources.data, setups.data, constraints.data, entities.data, shots.data, script.data]);

  return { data, pending, error, refetch: () => queries.forEach((q) => void q.refetch()) };
}

// ------------------------------------------------------------ local time ---

/** Today's date in the project time zone. */
export function todayIn(timezone: string): string {
  return utcToLocal(new Date().toISOString(), timezone).date;
}

export interface LocalWindow {
  date: string;
  start: string;
  end: string;
}

export function toLocalWindow(w: TimeWindow, timezone: string): LocalWindow {
  const s = utcToLocal(w.start_utc, timezone);
  return { date: s.date, start: s.time, end: utcToLocal(w.end_utc, timezone).time };
}

/** Local window → UTC (end ≤ start crosses midnight), or null when incomplete/invalid. */
export function fromLocalWindow(w: LocalWindow, timezone: string): TimeWindow | null {
  if (!w.date || !w.start || !w.end) return null;
  try {
    return localWindowToUtc(w.date, w.start, w.end, timezone);
  } catch {
    return null;
  }
}

/** "09:00–18:00", "22:00–次日 02:00", with the date when it is not `refDate`. */
export function windowLabel(w: TimeWindow, timezone: string, refDate: string | null): string {
  const s = utcToLocal(w.start_utc, timezone);
  const e = utcToLocal(w.end_utc, timezone);
  const day = refDate && s.date === refDate ? '' : `${Number(s.date.slice(5, 7))}/${Number(s.date.slice(8, 10))} `;
  const end = e.date === s.date ? e.time : `次日 ${e.time}`;
  return `${day}${s.time}–${end}`;
}

/** Characters used by active shots that no performer is cast to. */
export function uncastCharacters(data: Pick<PlanData, 'shots' | 'entities' | 'resources'>): Entity[] {
  const cast = new Set(data.resources.filter((r) => r.type === 'performer').flatMap((r) => r.cast_character_ids));
  const used = new Set(data.shots.filter((s) => s.required_status !== 'waived').flatMap((s) => s.fields.subjects.map((x) => x.alias)));
  return data.entities.filter((e) => e.type === 'character' && used.has(e.alias) && !cast.has(e.id));
}

export function setupMinutes(s: Setup, activeShots: number): number {
  return s.durations.setup_min + s.durations.per_shot_min * activeShots + s.durations.reset_min;
}
