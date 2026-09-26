import type { TimeWindow } from '@storyscript/contracts';
import type { ScheduleInput, ScheduleShot } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { listConstraints } from '../../db/repos/constraint.ts';
import { listEntities } from '../../db/repos/entity.ts';
import { listResources } from '../../db/repos/resource.ts';
import { listSetups } from '../../db/repos/setup.ts';
import { listActiveShots } from '../../db/repos/shot.ts';

/**
 * Builds core's ScheduleInput for one shooting day from the database.
 *
 *  - shots: every non-archived shot; performer_ids = the performer resources
 *    cast to the characters named in fields.subjects (alias → entity →
 *    Resource.cast_character_ids). No narrative order is passed (INV-01).
 *  - setups: stored setups with archived shots dropped from shot_ids, so
 *    archiving a shot does not turn the plan into "missing input".
 *  - constraints: confirmed ones only (unconfirmed ones are drafts).
 *  - no order_override: planInputHash must not depend on the manual order.
 */

export interface DayContext {
  date: string;
  timezone: string;
  crew_window: TimeWindow;
}

export function buildScheduleInput(db: DbPort, day: DayContext): ScheduleInput {
  const shots = listActiveShots(db);
  const active = new Set(shots.map((s) => s.id));
  const resources = listResources(db);

  const characterByAlias = new Map<string, string>();
  for (const e of listEntities(db)) if (e.type === 'character') characterByAlias.set(e.alias, e.id);
  const performersOf = new Map<string, string[]>();
  for (const r of resources) {
    if (r.type !== 'performer') continue;
    for (const entityId of r.cast_character_ids) performersOf.set(entityId, [...(performersOf.get(entityId) ?? []), r.id]);
  }

  const scheduleShots: ScheduleShot[] = shots.map((s) => {
    const ids = new Set<string>();
    for (const subject of s.fields.subjects) {
      const entityId = characterByAlias.get(subject.alias);
      for (const rid of entityId ? (performersOf.get(entityId) ?? []) : []) ids.add(rid);
    }
    return { id: s.id, required_status: s.required_status, performer_ids: [...ids] };
  });

  return {
    date: day.date,
    timezone: day.timezone,
    crew_window: { start_utc: day.crew_window.start_utc, end_utc: day.crew_window.end_utc },
    setups: listSetups(db).map((s) => ({ ...s, shot_ids: s.shot_ids.filter((id) => active.has(id)) })),
    resources,
    shots: scheduleShots,
    constraints: listConstraints(db).filter((c) => c.confirmed),
  };
}
