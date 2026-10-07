/**
 * 008 — S5a 粘贴整理 and todos:
 *   paste_note     a pasted text with the date its messages are from (to read
 *                  「周六下午」) and the project's time zone at the time
 *   paste_segment  one slice of it (≤ 3000 characters) and the one model job
 *                  that sorts it; its items wait for review
 *   paste_applied  which items were applied, by whom, and what they wrote
 *   todo           the group's todo list: a member (hosted, by account id) or
 *                  a typed name, a local due date and time, done by whom
 */
export const PASTE_TODO_SQL = `
CREATE TABLE paste_note (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  ref_date    TEXT NOT NULL,
  timezone    TEXT NOT NULL,
  hint        TEXT NOT NULL CHECK (hint IN ('auto', 'plan', 'set')),
  actor_id    TEXT,
  created_at  TEXT NOT NULL,
  closed_at   TEXT
) STRICT;
CREATE INDEX idx_paste_note_created ON paste_note(created_at);

CREATE TABLE paste_segment (
  note_id         TEXT NOT NULL REFERENCES paste_note(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL,
  job_id          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'partial', 'failed')),
  model           TEXT,
  prompt_version  TEXT,
  items_json      TEXT NOT NULL DEFAULT '[]',
  issues_json     TEXT NOT NULL DEFAULT '[]',
  raw_output      TEXT,
  error_json      TEXT,
  PRIMARY KEY (note_id, idx)
) STRICT;

CREATE TABLE paste_applied (
  note_id     TEXT NOT NULL REFERENCES paste_note(id) ON DELETE CASCADE,
  item_key    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  refs_json   TEXT NOT NULL,
  actor_id    TEXT,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (note_id, item_key)
) STRICT;

CREATE TABLE todo (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  assignee_id     TEXT,
  assignee_name   TEXT,
  due_date        TEXT,
  due_time        TEXT,
  done_at         TEXT,
  done_by         TEXT,
  source_note_id  TEXT,
  actor_id        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_todo_done ON todo(done_at, due_date);
`;
