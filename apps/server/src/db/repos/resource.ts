import { Resource } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** resource ↔ contracts Resource (FR-06). Windows are UTC [start, end). */

interface ResourceRow {
  id: string;
  type: string;
  name: string;
  windows_json: string;
  cast_character_ids_json: string;
  confirmed: number;
}

const COLS = 'id, type, name, windows_json, cast_character_ids_json, confirmed';

function fromRow(r: ResourceRow): Resource {
  return Resource.parse({
    id: r.id,
    type: r.type,
    name: r.name,
    windows: JSON.parse(r.windows_json),
    cast_character_ids: JSON.parse(r.cast_character_ids_json),
    confirmed: r.confirmed === 1,
  });
}

const TYPE_ORDER = "CASE type WHEN 'performer' THEN 0 WHEN 'location' THEN 1 ELSE 2 END";

/** Performers, then locations, then equipment; each by name. */
export function listResources(db: DbPort): Resource[] {
  return db.all<ResourceRow>(`SELECT ${COLS} FROM resource ORDER BY ${TYPE_ORDER}, name, rowid`).map(fromRow);
}

export function getResource(db: DbPort, id: string): Resource | null {
  const r = db.get<ResourceRow>(`SELECT ${COLS} FROM resource WHERE id = ?`, id);
  return r ? fromRow(r) : null;
}

export function insertResource(db: DbPort, res: Resource): void {
  const x = Resource.parse(res);
  db.run(
    `INSERT INTO resource (${COLS}) VALUES (?, ?, ?, ?, ?, ?)`,
    x.id,
    x.type,
    x.name,
    JSON.stringify(x.windows),
    JSON.stringify(x.cast_character_ids),
    x.confirmed ? 1 : 0,
  );
}

export function updateResourceRow(db: DbPort, res: Resource): void {
  const x = Resource.parse(res);
  db.run(
    'UPDATE resource SET type = ?, name = ?, windows_json = ?, cast_character_ids_json = ?, confirmed = ? WHERE id = ?',
    x.type,
    x.name,
    JSON.stringify(x.windows),
    JSON.stringify(x.cast_character_ids),
    x.confirmed ? 1 : 0,
    x.id,
  );
}

export function deleteResourceRow(db: DbPort, id: string): void {
  db.run('DELETE FROM resource WHERE id = ?', id);
}
