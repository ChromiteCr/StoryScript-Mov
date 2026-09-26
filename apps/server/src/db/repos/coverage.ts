import { CoverageDecision } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** coverage_decision ↔ contracts CoverageDecision. Append-only (triggers refuse UPDATE/DELETE). */

interface DecisionRow {
  id: string;
  shot_id: string;
  decision: string;
  selected_link_ids_json: string;
  reason: string;
  basis_content_hash: string;
  at: string;
}

const COLS = 'id, shot_id, decision, selected_link_ids_json, reason, basis_content_hash, at';

function fromRow(r: DecisionRow): CoverageDecision {
  return CoverageDecision.parse({ ...r, selected_link_ids: JSON.parse(r.selected_link_ids_json) });
}

export function listDecisions(db: DbPort): CoverageDecision[] {
  return db.all<DecisionRow>(`SELECT ${COLS} FROM coverage_decision ORDER BY at, id`).map(fromRow);
}

export function lastDecisionAt(db: DbPort, shotId: string): string | null {
  return db.get<{ at: string | null }>('SELECT MAX(at) AS at FROM coverage_decision WHERE shot_id = ?', shotId)?.at ?? null;
}

export function insertDecision(db: DbPort, d: CoverageDecision): void {
  const x = CoverageDecision.parse(d);
  db.run(
    `INSERT INTO coverage_decision (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.shot_id,
    x.decision,
    JSON.stringify(x.selected_link_ids),
    x.reason,
    x.basis_content_hash,
    x.at,
  );
}
