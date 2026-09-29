import { Entity, type EntityType } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** entity ↔ contracts Entity. Aliases c1/l1/o1 are allocated per type, never reused. */

interface EntityRow {
  id: string;
  type: string;
  alias: string;
  name: string;
  aliases_json: string;
  origin: string;
  confirmed: number;
  actor_name: string | null;
}

const COLS = 'id, type, alias, name, aliases_json, origin, confirmed, actor_name';
export const ALIAS_PREFIX: Record<EntityType, string> = { character: 'c', location: 'l', prop: 'o' };

function fromRow(r: EntityRow): Entity {
  return Entity.parse({ ...r, aliases: JSON.parse(r.aliases_json), confirmed: r.confirmed === 1 });
}

/** trim, drop empties and duplicates (and the name itself) */
export function cleanAliases(aliases: readonly string[], name?: string): string[] {
  const out: string[] = [];
  for (const a of aliases) {
    const t = a.trim();
    if (t && t !== name?.trim() && !out.includes(t)) out.push(t);
  }
  return out;
}

export function listEntities(db: DbPort): Entity[] {
  return db
    .all<EntityRow>(`SELECT ${COLS} FROM entity ORDER BY type, CAST(substr(alias, 2) AS INTEGER)`)
    .map(fromRow);
}

export function getEntity(db: DbPort, id: string): Entity | null {
  const r = db.get<EntityRow>(`SELECT ${COLS} FROM entity WHERE id = ?`, id);
  return r ? fromRow(r) : null;
}

export function findEntityByName(db: DbPort, type: EntityType, name: string): Entity | null {
  const r = db.get<EntityRow>(`SELECT ${COLS} FROM entity WHERE type = ? AND name = ? LIMIT 1`, type, name.trim());
  return r ? fromRow(r) : null;
}

/** Next free alias of a type: c1, c2 … (max + 1, so deleted/renamed aliases are never reused). */
export function nextAlias(db: DbPort, type: EntityType): string {
  const prefix = ALIAS_PREFIX[type];
  const row = db.get<{ n: number | null }>(
    `SELECT MAX(CAST(substr(alias, 2) AS INTEGER)) AS n FROM entity WHERE substr(alias, 1, 1) = ?`,
    prefix,
  );
  return `${prefix}${Number(row?.n ?? 0) + 1}`;
}

export function insertEntity(db: DbPort, e: Entity): void {
  const x = Entity.parse(e);
  db.run(
    `INSERT INTO entity (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.type,
    x.alias,
    x.name,
    JSON.stringify(x.aliases),
    x.origin,
    x.confirmed ? 1 : 0,
    x.actor_name,
  );
}

export function updateEntityRow(db: DbPort, e: Entity): void {
  const x = Entity.parse(e);
  db.run(
    'UPDATE entity SET name = ?, aliases_json = ?, confirmed = ?, actor_name = ? WHERE id = ?',
    x.name,
    JSON.stringify(x.aliases),
    x.confirmed ? 1 : 0,
    x.actor_name,
    x.id,
  );
}

/** Character aliases (c1, c2 …) — the roster handed to the model. */
export function characterRoster(db: DbPort): Pick<Entity, 'alias' | 'name' | 'aliases'>[] {
  return listEntities(db)
    .filter((e) => e.type === 'character')
    .map((e) => ({ alias: e.alias, name: e.name, aliases: e.aliases }));
}
