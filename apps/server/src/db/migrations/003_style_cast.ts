/**
 * 003 — S3 style cards and S3b cast:
 *   style             a group's own style cards (built-in cards live in core);
 *                     the group's defaults sit in kv under 'style_defaults'
 *   entity.actor_name who plays a character. Back-filled from the plan's
 *                     performer resources where exactly one performer plays
 *                     the character (two performers, e.g. a child and an
 *                     adult, stay for the user to decide).
 *   shot_draft        rebuilt: its kind CHECK gains 'style' and 'polish'
 *                     (SQLite cannot alter a CHECK in place)
 */
export const STYLE_CAST_SQL = `
CREATE TABLE style (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  grammar     TEXT NOT NULL,
  bias_json   TEXT NOT NULL,
  gear        TEXT NOT NULL,
  low_budget  TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('custom', 'researched')),
  reference   TEXT,
  unverified  INTEGER NOT NULL DEFAULT 0 CHECK (unverified IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_style_created ON style(created_at);

CREATE TABLE shot_draft_v3 (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('entities', 'breakdown', 'order', 'style', 'polish')),
  scope_json     TEXT NOT NULL DEFAULT '{}',
  model          TEXT,
  prompt_version TEXT NOT NULL,
  raw_output     TEXT,
  parsed_json    TEXT,
  issues_json    TEXT NOT NULL DEFAULT '[]',
  attempts       INTEGER NOT NULL DEFAULT 0,
  usage_json     TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'discarded', 'failed')),
  created_at     TEXT NOT NULL
) STRICT;
INSERT INTO shot_draft_v3 (id, kind, scope_json, model, prompt_version, raw_output, parsed_json, issues_json, attempts, usage_json, status, created_at)
  SELECT id, kind, scope_json, model, prompt_version, raw_output, parsed_json, issues_json, attempts, usage_json, status, created_at FROM shot_draft;
DROP TABLE shot_draft;
ALTER TABLE shot_draft_v3 RENAME TO shot_draft;
CREATE INDEX idx_shot_draft_kind_status ON shot_draft(kind, status, created_at);

ALTER TABLE entity ADD COLUMN actor_name TEXT;
UPDATE entity SET actor_name = (
  SELECT r.name FROM resource r, json_each(r.cast_character_ids_json) j
  WHERE r.type = 'performer' AND j.value = entity.id
)
WHERE type = 'character' AND (
  SELECT COUNT(*) FROM resource r, json_each(r.cast_character_ids_json) j
  WHERE r.type = 'performer' AND j.value = entity.id
) = 1;
`;
