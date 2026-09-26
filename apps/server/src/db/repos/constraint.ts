import { Constraint } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** schedule_constraint ↔ contracts Constraint (discriminated by type). */

interface ConstraintRow {
  id: string;
  type: string;
  a_setup_id: string | null;
  b_setup_id: string | null;
  setup_id: string | null;
  at_utc: string | null;
  start_utc: string | null;
  end_utc: string | null;
  confirmed: number;
}

const COLS = 'id, type, a_setup_id, b_setup_id, setup_id, at_utc, start_utc, end_utc, confirmed';

function fromRow(r: ConstraintRow): Constraint {
  const confirmed = r.confirmed === 1;
  switch (r.type) {
    case 'before':
      return Constraint.parse({ id: r.id, type: 'before', a_setup_id: r.a_setup_id, b_setup_id: r.b_setup_id, confirmed });
    case 'not_before':
    case 'not_after':
      return Constraint.parse({ id: r.id, type: r.type, setup_id: r.setup_id, at_utc: r.at_utc, confirmed });
    default:
      return Constraint.parse({ id: r.id, type: r.type, setup_id: r.setup_id, start_utc: r.start_utc, end_utc: r.end_utc, confirmed });
  }
}

export function listConstraints(db: DbPort): Constraint[] {
  return db.all<ConstraintRow>(`SELECT ${COLS} FROM schedule_constraint ORDER BY rowid`).map(fromRow);
}

export function getConstraint(db: DbPort, id: string): Constraint | null {
  const r = db.get<ConstraintRow>(`SELECT ${COLS} FROM schedule_constraint WHERE id = ?`, id);
  return r ? fromRow(r) : null;
}

export function insertConstraint(db: DbPort, c: Constraint): void {
  const x = Constraint.parse(c);
  const row = {
    a: x.type === 'before' ? x.a_setup_id : null,
    b: x.type === 'before' ? x.b_setup_id : null,
    setup: x.type === 'before' ? null : x.setup_id,
    at: x.type === 'not_before' || x.type === 'not_after' ? x.at_utc : null,
    start: x.type === 'locked_block' ? x.start_utc : null,
    end: x.type === 'locked_block' ? x.end_utc : null,
  };
  db.run(
    `INSERT INTO schedule_constraint (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.type,
    row.a,
    row.b,
    row.setup,
    row.at,
    row.start,
    row.end,
    x.confirmed ? 1 : 0,
  );
}

export function deleteConstraintRow(db: DbPort, id: string): void {
  db.run('DELETE FROM schedule_constraint WHERE id = ?', id);
}
