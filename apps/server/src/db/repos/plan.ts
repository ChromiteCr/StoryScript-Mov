import { Plan, TimeWindow } from '@storyscript/contracts';
import { z } from 'zod';
import type { DbPort } from '../port.ts';

/**
 * plan ↔ contracts Plan. The crew call/wrap a plan was created with (needed to
 * rebuild its ScheduleInput for stale checks) has no column in 001_init, so it
 * lives in the kv table under `plan.meta.<id>` together with whether the
 * current order was set by hand (reorder / adopted suggestion).
 */

interface PlanRow {
  id: string;
  date: string;
  timezone: string;
  day_start_utc: string;
  result_json: string;
  input_hash: string;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

const COLS = 'id, date, timezone, day_start_utc, result_json, input_hash, status, revision, created_at, updated_at';

function fromRow(r: PlanRow): Plan {
  return Plan.parse({ ...r, result: JSON.parse(r.result_json) });
}

/** Newest shooting date first, then newest created. */
export function listPlans(db: DbPort): Plan[] {
  return db.all<PlanRow>(`SELECT ${COLS} FROM plan ORDER BY date DESC, created_at DESC, rowid DESC`).map(fromRow);
}

export function getPlan(db: DbPort, id: string): Plan | null {
  const r = db.get<PlanRow>(`SELECT ${COLS} FROM plan WHERE id = ?`, id);
  return r ? fromRow(r) : null;
}

export function insertPlan(db: DbPort, p: Plan): void {
  const x = Plan.parse(p);
  db.run(
    `INSERT INTO plan (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.date,
    x.timezone,
    x.day_start_utc,
    JSON.stringify(x.result),
    x.input_hash,
    x.status,
    x.revision,
    x.created_at,
    x.updated_at,
  );
}

export function updatePlanRow(db: DbPort, p: Plan): void {
  const x = Plan.parse(p);
  db.run(
    'UPDATE plan SET result_json = ?, input_hash = ?, status = ?, revision = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(x.result),
    x.input_hash,
    x.status,
    x.revision,
    x.updated_at,
    x.id,
  );
}

// ------------------------------------------------------------------- meta ---

export const PlanMeta = z.object({
  crew_call: z.string(),
  crew_wrap: z.string(),
  crew_window: TimeWindow,
  /** true once the order was set by hand (reorder, adopted suggestion) */
  order_manual: z.boolean(),
});
export type PlanMeta = z.infer<typeof PlanMeta>;

const metaKey = (id: string) => `plan.meta.${id}`;

export function readPlanMeta(db: DbPort, id: string): PlanMeta | null {
  const r = db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', metaKey(id));
  if (!r) return null;
  try {
    const parsed = PlanMeta.safeParse(JSON.parse(r.value_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writePlanMeta(db: DbPort, id: string, meta: PlanMeta, now = new Date().toISOString()): void {
  db.run(
    'INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    metaKey(id),
    JSON.stringify(PlanMeta.parse(meta)),
    now,
  );
}
