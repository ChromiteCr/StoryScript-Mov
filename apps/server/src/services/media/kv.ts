import type { DbPort } from '../../db/port.ts';

/**
 * Small side records of the media loop kept in the generic kv table (no new
 * columns): take correction audit and inexact-range notes. Keys are prefixed
 * per concern; values are JSON.
 */

export function kvGet<T>(db: DbPort, key: string): T | null {
  const r = db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', key);
  return r ? (JSON.parse(r.value_json) as T) : null;
}

export function kvPut(db: DbPort, key: string, value: unknown, now: string): void {
  db.run(
    'INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    key,
    JSON.stringify(value),
    now,
  );
}

export function kvDelete(db: DbPort, key: string): void {
  db.run('DELETE FROM kv WHERE key = ?', key);
}

export const takeAuditKey = (takeId: string) => `take_audit:${takeId}`;
export const linkInexactKey = (linkId: string) => `link_range_inexact:${linkId}`;
