/**
 * 004 — S4 who did it (hosted server; local rows stay NULL):
 *   member            the group's people as this project last saw them
 *                     (name, crew roles), so history keeps a name after
 *                     someone renames or leaves; never an email
 *   *.actor_id        the account behind each history row: shot revisions,
 *                     board versions and redraws, script versions, coverage
 *                     decisions, AI drafts (who asked) and jobs
 *   job.model_source  whose model a job used: 'group' or 'own'
 *   plan              created_by, approved_by, approved_at
 *   take              logged_by
 */
export const ACTORS_SQL = `
CREATE TABLE member (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  crew_roles_json TEXT NOT NULL DEFAULT '[]',
  updated_at      TEXT NOT NULL
) STRICT;

ALTER TABLE shot_revision ADD COLUMN actor_id TEXT;
ALTER TABLE board ADD COLUMN actor_id TEXT;
ALTER TABLE board_raster ADD COLUMN actor_id TEXT;
ALTER TABLE script_version ADD COLUMN actor_id TEXT;
ALTER TABLE coverage_decision ADD COLUMN actor_id TEXT;
ALTER TABLE shot_draft ADD COLUMN actor_id TEXT;
ALTER TABLE job ADD COLUMN actor_id TEXT;
ALTER TABLE job ADD COLUMN model_source TEXT CHECK (model_source IS NULL OR model_source IN ('group', 'own'));
ALTER TABLE plan ADD COLUMN created_by TEXT;
ALTER TABLE plan ADD COLUMN approved_by TEXT;
ALTER TABLE plan ADD COLUMN approved_at TEXT;
ALTER TABLE take ADD COLUMN logged_by TEXT;
`;
