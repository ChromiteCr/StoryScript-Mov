import { StyleBias, StyleCard, StyleDefaults } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** style ↔ contracts StyleCard (the group's own cards), and the group's defaults in kv. */

interface StyleRow {
  id: string;
  name: string;
  summary: string;
  grammar: string;
  bias_json: string;
  gear: string;
  low_budget: string;
  origin: string;
  reference: string | null;
  unverified: number;
  created_at: string;
  updated_at: string;
  revision: number;
}

const COLS = 'id, name, summary, grammar, bias_json, gear, low_budget, origin, reference, unverified, created_at, updated_at, revision';
const DEFAULTS_KEY = 'style_defaults';

function fromRow(r: StyleRow): StyleCard {
  return StyleCard.parse({ ...r, bias: StyleBias.parse(JSON.parse(r.bias_json)), unverified: r.unverified === 1 });
}

export function listStyles(db: DbPort): StyleCard[] {
  return db.all<StyleRow>(`SELECT ${COLS} FROM style ORDER BY created_at, id`).map(fromRow);
}

export function getStyle(db: DbPort, id: string): StyleCard | null {
  const r = db.get<StyleRow>(`SELECT ${COLS} FROM style WHERE id = ?`, id);
  return r ? fromRow(r) : null;
}

export function insertStyle(db: DbPort, card: StyleCard): void {
  const x = StyleCard.parse(card);
  db.run(
    'INSERT INTO style (id, name, summary, grammar, bias_json, gear, low_budget, origin, reference, unverified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    x.id,
    x.name,
    x.summary,
    x.grammar,
    JSON.stringify(x.bias),
    x.gear,
    x.low_budget,
    x.origin,
    x.reference,
    x.unverified ? 1 : 0,
    x.created_at,
    x.updated_at,
  );
}

export function updateStyleRow(db: DbPort, card: StyleCard): void {
  const x = StyleCard.parse(card);
  db.run(
    'UPDATE style SET name = ?, summary = ?, grammar = ?, bias_json = ?, gear = ?, low_budget = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
    x.name,
    x.summary,
    x.grammar,
    JSON.stringify(x.bias),
    x.gear,
    x.low_budget,
    x.updated_at,
    x.id,
  );
}

export function deleteStyleRow(db: DbPort, id: string): void {
  db.run('DELETE FROM style WHERE id = ?', id);
}

export function readStyleDefaults(db: DbPort): StyleDefaults {
  const r = db.get<{ value_json: string }>('SELECT value_json FROM kv WHERE key = ?', DEFAULTS_KEY);
  const parsed = r ? StyleDefaults.safeParse(JSON.parse(r.value_json)) : null;
  return parsed?.success ? parsed.data : { style_id: null, level: 'steady' };
}

export function writeStyleDefaults(db: DbPort, d: StyleDefaults, now: string): void {
  db.run(
    'INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    DEFAULTS_KEY,
    JSON.stringify(StyleDefaults.parse(d)),
    now,
  );
}
