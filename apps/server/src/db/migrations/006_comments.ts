/**
 * 006 — S4b shot comments (hosted server):
 *   comment          one message on a shot (optionally about one board
 *                    version); one level of replies; soft-deleted so a
 *                    thread stays readable; `n` orders them for unread counts
 *   comment_mention  who was @-mentioned (a role like @导演 is expanded to
 *                    its holders when the comment is written)
 *   comment_read     per account and shot: the last comment `n` read
 */
export const COMMENTS_SQL = `
CREATE TABLE comment (
  n                  INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  shot_id            TEXT NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  board_id           TEXT REFERENCES board(id) ON DELETE SET NULL,
  parent_id          TEXT REFERENCES comment(id),
  actor_id           TEXT NOT NULL,
  body               TEXT NOT NULL,
  mention_roles_json TEXT NOT NULL DEFAULT '[]',
  resolved_at        TEXT,
  resolved_by        TEXT,
  edited_at          TEXT,
  deleted_at         TEXT,
  created_at         TEXT NOT NULL
) STRICT;
CREATE INDEX idx_comment_shot ON comment(shot_id, n);

CREATE TABLE comment_mention (
  comment_id TEXT NOT NULL REFERENCES comment(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  seen_at    TEXT,
  PRIMARY KEY (comment_id, account_id)
) STRICT;
CREATE INDEX idx_comment_mention_account ON comment_mention(account_id, seen_at);

CREATE TABLE comment_read (
  account_id TEXT NOT NULL,
  shot_id    TEXT NOT NULL,
  read_n     INTEGER NOT NULL,
  PRIMARY KEY (account_id, shot_id)
) STRICT;
`;
