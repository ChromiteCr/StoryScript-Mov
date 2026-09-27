import { SourceRoot } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** source_root ↔ contracts SourceRoot. abs_path is always a realpath. */

const COLS = 'id, kind, abs_path, label, created_at';

export function listRoots(db: DbPort): SourceRoot[] {
  return db.all<SourceRoot>(`SELECT ${COLS} FROM source_root ORDER BY created_at, rowid`).map((r) => SourceRoot.parse(r));
}

export function getRoot(db: DbPort, id: string): SourceRoot | null {
  const r = db.get<SourceRoot>(`SELECT ${COLS} FROM source_root WHERE id = ?`, id);
  return r ? SourceRoot.parse(r) : null;
}

export function getRootByPath(db: DbPort, absPath: string): SourceRoot | null {
  const r = db.get<SourceRoot>(`SELECT ${COLS} FROM source_root WHERE abs_path = ?`, absPath);
  return r ? SourceRoot.parse(r) : null;
}

export function insertRoot(db: DbPort, root: SourceRoot): void {
  const x = SourceRoot.parse(root);
  db.run(`INSERT INTO source_root (${COLS}) VALUES (?, ?, ?, ?, ?)`, x.id, x.kind, x.abs_path, x.label, x.created_at);
}
