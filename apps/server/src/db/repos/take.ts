import { Take } from '@storyscript/contracts';
import { actorId, actorResolver } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/**
 * take / take_shot ↔ contracts Take. take_shot rows are independent of any
 * media (SPEC FR-07, INV-06); `sort` keeps Take.shot_ids order.
 */

interface TakeRow {
  id: string;
  setup_id: string | null;
  take_no: number;
  camera_label: string | null;
  rating: string;
  clip_hint: string | null;
  notes: string;
  unresolved_labels_json: string;
  logged_at: string;
  revision: number;
  logged_by: string | null;
}

const COLS = 'id, setup_id, take_no, camera_label, rating, clip_hint, notes, unresolved_labels_json, logged_at, revision, logged_by';

function shotIdsByTake(db: DbPort, takeIds?: readonly string[]): Map<string, string[]> {
  const rows =
    takeIds === undefined
      ? db.all<{ take_id: string; shot_id: string }>('SELECT take_id, shot_id FROM take_shot ORDER BY take_id, sort')
      : takeIds.length === 0
        ? []
        : db.all<{ take_id: string; shot_id: string }>(
            `SELECT take_id, shot_id FROM take_shot WHERE take_id IN (${takeIds.map(() => '?').join(', ')}) ORDER BY take_id, sort`,
            ...takeIds,
          );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.take_id);
    if (list) list.push(r.shot_id);
    else map.set(r.take_id, [r.shot_id]);
  }
  return map;
}

function fromRow(r: TakeRow, shotIds: string[], who: ReturnType<typeof actorResolver>): Take {
  return Take.parse({
    ...r,
    logged_by: who(r.logged_by),
    unresolved_labels: JSON.parse(r.unresolved_labels_json),
    shot_ids: shotIds,
  });
}

/** All takes, oldest logged first. */
export function listTakes(db: DbPort): Take[] {
  const rows = db.all<TakeRow>(`SELECT ${COLS} FROM take ORDER BY logged_at, rowid`);
  const shots = shotIdsByTake(db);
  const who = actorResolver(db);
  return rows.map((r) => fromRow(r, shots.get(r.id) ?? [], who));
}

export function getTake(db: DbPort, id: string): Take | null {
  const r = db.get<TakeRow>(`SELECT ${COLS} FROM take WHERE id = ?`, id);
  if (!r) return null;
  return fromRow(r, shotIdsByTake(db, [id]).get(id) ?? [], actorResolver(db));
}

function writeShots(db: DbPort, takeId: string, shotIds: readonly string[]): void {
  db.run('DELETE FROM take_shot WHERE take_id = ?', takeId);
  shotIds.forEach((sid, i) => db.run('INSERT INTO take_shot (take_id, shot_id, sort) VALUES (?, ?, ?)', takeId, sid, i));
}

export function insertTake(db: DbPort, t: Take): void {
  const x = Take.parse(t);
  db.run(
    `INSERT INTO take (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.setup_id,
    x.take_no,
    x.camera_label,
    x.rating,
    x.clip_hint,
    x.notes,
    JSON.stringify(x.unresolved_labels),
    x.logged_at,
    x.revision,
    actorId(),
  );
  writeShots(db, x.id, x.shot_ids);
}

/** Overwrite every column and the shot set of an existing take. */
export function updateTakeRow(db: DbPort, t: Take): void {
  const x = Take.parse(t);
  db.run(
    `UPDATE take SET setup_id = ?, take_no = ?, camera_label = ?, rating = ?, clip_hint = ?, notes = ?,
       unresolved_labels_json = ?, logged_at = ?, revision = ? WHERE id = ?`,
    x.setup_id,
    x.take_no,
    x.camera_label,
    x.rating,
    x.clip_hint,
    x.notes,
    JSON.stringify(x.unresolved_labels),
    x.logged_at,
    x.revision,
    x.id,
  );
  writeShots(db, x.id, x.shot_ids);
}

/** Canonical key of a shot set (order-insensitive). */
export function shotSetKey(shotIds: readonly string[]): string {
  return [...new Set(shotIds)].sort().join('|');
}

/**
 * Next take number for exactly this set of shots (1 when none logged yet).
 * A take without shots is keyed by its unresolved labels instead.
 */
export function nextTakeNo(db: DbPort, shotIds: readonly string[], unresolvedLabels: readonly string[] = []): number {
  const key = shotSetKey(shotIds);
  const labelKey = shotSetKey(unresolvedLabels.map((l) => l.trim().toLowerCase()));
  let max = 0;
  for (const t of listTakes(db)) {
    const same =
      key === '' ? t.shot_ids.length === 0 && shotSetKey(t.unresolved_labels.map((l) => l.trim().toLowerCase())) === labelKey : shotSetKey(t.shot_ids) === key;
    if (same) max = Math.max(max, t.take_no);
  }
  return max + 1;
}
