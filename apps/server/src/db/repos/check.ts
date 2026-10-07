import type { DraftIssue, ScriptCheckItem, ScriptCheckStatus, ScriptRiskCategory, ScriptRiskSeverity } from '@storyscript/contracts';
import { actorId } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/** script_check / script_risk (S5 剧本体检): one check of a script version and its difficulties. */

export interface CheckRow {
  id: string;
  script_version_id: string;
  job_id: string | null;
  model: string | null;
  prompt_version: string;
  issues: DraftIssue[];
  attempts: number;
  status: ScriptCheckStatus;
  actor_id: string | null;
  created_at: string;
}

export interface RiskRow {
  id: string;
  check_id: string;
  sort: number;
  paragraph_id: string;
  category: ScriptRiskCategory;
  severity: ScriptRiskSeverity;
  quote: string;
  problem: string;
  alternative: string;
  handled_at: string | null;
  handled_by: string | null;
}

const CHECK_COLS = 'id, script_version_id, job_id, model, prompt_version, issues_json, attempts, status, actor_id, created_at';
const RISK_COLS = 'id, check_id, sort, paragraph_id, category, severity, quote, problem, alternative, handled_at, handled_by';

type CheckDbRow = Omit<CheckRow, 'issues'> & { issues_json: string };

const checkFromRow = (r: CheckDbRow): CheckRow => {
  const { issues_json, ...rest } = r;
  return { ...rest, issues: JSON.parse(issues_json) as DraftIssue[] };
};

export interface NewCheck {
  id: string;
  script_version_id: string;
  job_id: string | null;
  model: string | null;
  prompt_version: string;
  raw_output: string | null;
  issues: DraftIssue[];
  attempts: number;
  usage: Record<string, number> | null;
  status: ScriptCheckStatus;
  created_at: string;
  risks: (ScriptCheckItem & { id: string; handled_at: string | null; handled_by: string | null })[];
}

export function insertCheck(db: DbPort, c: NewCheck): void {
  db.run(
    `INSERT INTO script_check (id, script_version_id, job_id, model, prompt_version, raw_output, issues_json, attempts, usage_json, status, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id,
    c.script_version_id,
    c.job_id,
    c.model,
    c.prompt_version,
    c.raw_output,
    JSON.stringify(c.issues),
    c.attempts,
    c.usage === null ? null : JSON.stringify(c.usage),
    c.status,
    actorId(),
    c.created_at,
  );
  c.risks.forEach((r, sort) =>
    db.run(
      `INSERT INTO script_risk (${RISK_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      c.id,
      sort,
      r.paragraph_id,
      r.category,
      r.severity,
      r.quote,
      r.problem,
      r.alternative,
      r.handled_at,
      r.handled_by,
    ),
  );
}

/** The latest check (by time, then insertion). */
export function latestCheck(db: DbPort): CheckRow | null {
  const r = db.get<CheckDbRow>(`SELECT ${CHECK_COLS} FROM script_check ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  return r ? checkFromRow(r) : null;
}

export function checkVersionOf(db: DbPort, checkId: string): string | null {
  return db.get<{ v: string }>('SELECT script_version_id AS v FROM script_check WHERE id = ?', checkId)?.v ?? null;
}

export function listRisks(db: DbPort, checkId: string): RiskRow[] {
  return db.all<RiskRow>(`SELECT ${RISK_COLS} FROM script_risk WHERE check_id = ? ORDER BY sort`, checkId);
}

export function getRisk(db: DbPort, id: string): RiskRow | null {
  return db.get<RiskRow>(`SELECT ${RISK_COLS} FROM script_risk WHERE id = ?`, id) ?? null;
}

export function setRiskHandledRow(db: DbPort, id: string, at: string | null): void {
  db.run('UPDATE script_risk SET handled_at = ?, handled_by = ? WHERE id = ?', at, at ? actorId() : null, id);
}
