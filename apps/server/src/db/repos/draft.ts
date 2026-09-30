import { ShotDraft, type DraftStatus } from '@storyscript/contracts';
import { actorId, actorResolver } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/** shot_draft ↔ contracts ShotDraft. AI output only ever lands here (INV-03). */

interface DraftRow {
  id: string;
  kind: string;
  scope_json: string;
  model: string | null;
  prompt_version: string;
  raw_output: string | null;
  parsed_json: string | null;
  issues_json: string;
  attempts: number;
  usage_json: string | null;
  status: string;
  created_at: string;
  actor_id: string | null;
}

const COLS =
  'id, kind, scope_json, model, prompt_version, raw_output, parsed_json, issues_json, attempts, usage_json, status, created_at, actor_id';

function fromRow(r: DraftRow, who: ReturnType<typeof actorResolver>): ShotDraft {
  return ShotDraft.parse({
    ...r,
    scope: JSON.parse(r.scope_json),
    parsed: r.parsed_json === null ? null : JSON.parse(r.parsed_json),
    issues: JSON.parse(r.issues_json),
    usage: r.usage_json === null ? null : JSON.parse(r.usage_json),
    actor: who(r.actor_id),
  });
}

export function insertDraft(db: DbPort, d: ShotDraft): void {
  const x = ShotDraft.parse(d);
  db.run(
    `INSERT INTO shot_draft (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.kind,
    JSON.stringify(x.scope),
    x.model,
    x.prompt_version,
    x.raw_output,
    x.parsed === null || x.parsed === undefined ? null : JSON.stringify(x.parsed),
    JSON.stringify(x.issues),
    x.attempts,
    x.usage === null ? null : JSON.stringify(x.usage),
    x.status,
    x.created_at,
    actorId(),
  );
}

export function getDraft(db: DbPort, id: string): ShotDraft | null {
  const r = db.get<DraftRow>(`SELECT ${COLS} FROM shot_draft WHERE id = ?`, id);
  return r ? fromRow(r, actorResolver(db)) : null;
}

export function listDrafts(db: DbPort): ShotDraft[] {
  const who = actorResolver(db);
  return db.all<DraftRow>(`SELECT ${COLS} FROM shot_draft ORDER BY created_at DESC, rowid DESC`).map((r) => fromRow(r, who));
}

export function setDraftStatus(db: DbPort, id: string, status: DraftStatus): void {
  db.run('UPDATE shot_draft SET status = ? WHERE id = ?', status, id);
}
