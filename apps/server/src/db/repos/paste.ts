import type { DraftIssue, PasteHint, PasteItem, PasteKind, PasteSegmentStatus } from '@storyscript/contracts';
import { actorId } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/** paste_note / paste_segment / paste_applied (S5a 粘贴整理). */

export interface NoteRow {
  id: string;
  text: string;
  ref_date: string;
  timezone: string;
  hint: PasteHint;
  actor_id: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface SegmentRow {
  note_id: string;
  idx: number;
  start_at: number;
  end_at: number;
  job_id: string | null;
  status: PasteSegmentStatus;
  model: string | null;
  prompt_version: string | null;
  items: PasteItem[];
  issues: DraftIssue[];
  error: { code: string; message: string } | null;
}

export interface AppliedRow {
  item_key: string;
  kind: PasteKind;
  refs: Record<string, string[]>;
  actor_id: string | null;
  applied_at: string;
}

const NOTE_COLS = 'id, text, ref_date, timezone, hint, actor_id, created_at, closed_at';
const SEG_COLS = 'note_id, idx, start_at, end_at, job_id, status, model, prompt_version, items_json, issues_json, error_json';

type SegDbRow = Omit<SegmentRow, 'items' | 'issues' | 'error'> & { items_json: string; issues_json: string; error_json: string | null };
const segFromRow = ({ items_json, issues_json, error_json, ...r }: SegDbRow): SegmentRow => ({
  ...r,
  items: JSON.parse(items_json) as PasteItem[],
  issues: JSON.parse(issues_json) as DraftIssue[],
  error: error_json ? (JSON.parse(error_json) as SegmentRow['error']) : null,
});

export function insertNote(db: DbPort, n: Omit<NoteRow, 'actor_id' | 'closed_at'>, segments: readonly { start: number; end: number }[]): void {
  db.run(`INSERT INTO paste_note (${NOTE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, n.id, n.text, n.ref_date, n.timezone, n.hint, actorId(), n.created_at);
  segments.forEach((s, idx) =>
    db.run(`INSERT INTO paste_segment (note_id, idx, start_at, end_at, status) VALUES (?, ?, ?, ?, 'pending')`, n.id, idx, s.start, s.end),
  );
}

export function getNote(db: DbPort, id: string): NoteRow | null {
  return db.get<NoteRow>(`SELECT ${NOTE_COLS} FROM paste_note WHERE id = ?`, id) ?? null;
}

/** Open notes first, then by time, newest first. */
export function listNotes(db: DbPort, limit = 30): NoteRow[] {
  return db.all<NoteRow>(`SELECT ${NOTE_COLS} FROM paste_note ORDER BY closed_at IS NOT NULL, created_at DESC LIMIT ?`, limit);
}

export function closeNoteRow(db: DbPort, id: string, at: string): void {
  db.run('UPDATE paste_note SET closed_at = COALESCE(closed_at, ?) WHERE id = ?', at, id);
}

export function listSegments(db: DbPort, noteId: string): SegmentRow[] {
  return db.all<SegDbRow>(`SELECT ${SEG_COLS} FROM paste_segment WHERE note_id = ? ORDER BY idx`, noteId).map(segFromRow);
}

export function setSegmentJob(db: DbPort, noteId: string, idx: number, jobId: string): void {
  db.run("UPDATE paste_segment SET job_id = ?, status = 'pending', error_json = NULL WHERE note_id = ? AND idx = ?", jobId, noteId, idx);
}

export function finishSegment(
  db: DbPort,
  noteId: string,
  idx: number,
  s: { status: PasteSegmentStatus; model: string | null; prompt_version: string; items: PasteItem[]; issues: DraftIssue[]; raw_output: string | null; error: SegmentRow['error'] },
): void {
  db.run(
    'UPDATE paste_segment SET status = ?, model = ?, prompt_version = ?, items_json = ?, issues_json = ?, raw_output = ?, error_json = ? WHERE note_id = ? AND idx = ?',
    s.status,
    s.model,
    s.prompt_version,
    JSON.stringify(s.items),
    JSON.stringify(s.issues),
    s.raw_output,
    s.error ? JSON.stringify(s.error) : null,
    noteId,
    idx,
  );
}

export function listApplied(db: DbPort, noteId: string): AppliedRow[] {
  return db
    .all<Omit<AppliedRow, 'refs'> & { refs_json: string }>('SELECT item_key, kind, refs_json, actor_id, applied_at FROM paste_applied WHERE note_id = ?', noteId)
    .map(({ refs_json, ...r }) => ({ ...r, refs: JSON.parse(refs_json) as AppliedRow['refs'] }));
}

export function insertApplied(db: DbPort, noteId: string, a: Omit<AppliedRow, 'actor_id'>): void {
  db.run(
    'INSERT INTO paste_applied (note_id, item_key, kind, refs_json, actor_id, applied_at) VALUES (?, ?, ?, ?, ?, ?)',
    noteId,
    a.item_key,
    a.kind,
    JSON.stringify(a.refs),
    actorId(),
    a.applied_at,
  );
}
