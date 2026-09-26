/**
 * 001_init — v0.1 schema. Columns mirror packages/contracts field names;
 * nested structures live in *_json TEXT columns, booleans are INTEGER 0/1.
 * All tables are STRICT. Timestamps are UTC ISO-8601 strings.
 */
export const INIT_SQL = /* sql */ `
CREATE TABLE project (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  default_aspect    TEXT NOT NULL,
  target_duration_s INTEGER,
  look_preset_id    TEXT NOT NULL,
  code_format       TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE TABLE script_version (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES script_version(id),
  source_name     TEXT NOT NULL,
  format          TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  raw_text        TEXT NOT NULL,
  paragraphs_json TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX idx_script_version_created ON script_version(created_at);

CREATE TABLE entity (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('character', 'location', 'prop')),
  alias        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  origin       TEXT NOT NULL,
  confirmed    INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1))
) STRICT;
CREATE INDEX idx_entity_type ON entity(type);

CREATE TABLE scene (
  id                 TEXT PRIMARY KEY,
  script_version_id  TEXT NOT NULL REFERENCES script_version(id),
  sort               INTEGER NOT NULL,
  display_no         TEXT NOT NULL,
  heading            TEXT NOT NULL,
  paragraph_ids_json TEXT NOT NULL DEFAULT '[]',
  location_entity_id TEXT REFERENCES entity(id) ON DELETE SET NULL,
  time_label         TEXT,
  screen_sides_json  TEXT,
  origin             TEXT NOT NULL
) STRICT;
CREATE INDEX idx_scene_version_sort ON scene(script_version_id, sort);

CREATE TABLE resource (
  id                      TEXT PRIMARY KEY,
  type                    TEXT NOT NULL CHECK (type IN ('performer', 'location', 'equipment')),
  name                    TEXT NOT NULL,
  windows_json            TEXT NOT NULL DEFAULT '[]',
  cast_character_ids_json TEXT NOT NULL DEFAULT '[]',
  confirmed               INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1))
) STRICT;
CREATE INDEX idx_resource_type ON resource(type);

-- Setup.shot_ids (ordered) mirrors shot.setup_id; repos keep the two in sync
CREATE TABLE setup (
  id                   TEXT PRIMARY KEY,
  location_resource_id TEXT REFERENCES resource(id) ON DELETE SET NULL,
  label                TEXT NOT NULL,
  shot_ids_json        TEXT NOT NULL DEFAULT '[]',
  resource_ids_json    TEXT NOT NULL DEFAULT '[]',
  durations_json       TEXT NOT NULL,
  estimate_confirmed   INTEGER NOT NULL DEFAULT 0 CHECK (estimate_confirmed IN (0, 1))
) STRICT;
CREATE INDEX idx_setup_location ON setup(location_resource_id);

CREATE TABLE shot (
  id                 TEXT PRIMARY KEY,
  scene_id           TEXT NOT NULL REFERENCES scene(id),
  code               TEXT NOT NULL,
  narrative_pos      REAL NOT NULL,
  source_anchor_json TEXT,
  manual_note        TEXT,
  origin             TEXT NOT NULL,
  fields_json        TEXT NOT NULL,
  locked             INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  archived           INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  required_status    TEXT NOT NULL DEFAULT 'required' CHECK (required_status IN ('required', 'optional', 'waived')),
  requirement_reason TEXT,
  setup_id           TEXT REFERENCES setup(id) ON DELETE SET NULL,
  needs_relink       INTEGER NOT NULL DEFAULT 0 CHECK (needs_relink IN (0, 1)),
  content_hash       TEXT NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;
CREATE INDEX idx_shot_scene_pos ON shot(scene_id, narrative_pos);
CREATE INDEX idx_shot_setup ON shot(setup_id);
CREATE INDEX idx_shot_code ON shot(code);

CREATE TABLE shot_revision (
  id          TEXT PRIMARY KEY,
  shot_id     TEXT NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  fields_json TEXT NOT NULL,
  origin      TEXT NOT NULL,
  reason      TEXT,
  at          TEXT NOT NULL,
  UNIQUE (shot_id, revision)
) STRICT;

CREATE TABLE shot_draft (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('entities', 'breakdown', 'order')),
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
CREATE INDEX idx_shot_draft_kind_status ON shot_draft(kind, status, created_at);

-- user-authored techniques only (builtins live in core/presets); id is the stable key
CREATE TABLE technique (
  id                     TEXT PRIMARY KEY,
  version                INTEGER NOT NULL,
  name                   TEXT NOT NULL,
  intended_effect        TEXT NOT NULL,
  shot_grammar           TEXT NOT NULL,
  camera_defaults_json   TEXT NOT NULL,
  applicable_scenes      TEXT NOT NULL,
  resource_cost_notes    TEXT NOT NULL,
  low_budget_alternative TEXT NOT NULL,
  sources_json           TEXT NOT NULL DEFAULT '[]',
  limitations            TEXT NOT NULL,
  builtin                INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1))
) STRICT;

CREATE TABLE board (
  id                 TEXT PRIMARY KEY,
  shot_id            TEXT NOT NULL REFERENCES shot(id),
  version            INTEGER NOT NULL,
  parent_board_id    TEXT REFERENCES board(id),
  spec_json          TEXT NOT NULL,
  renderer_version   TEXT NOT NULL,
  basis_content_hash TEXT NOT NULL,
  user_edited        INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0, 1)),
  revision           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  UNIQUE (shot_id, version)
) STRICT;

CREATE TABLE board_raster (
  id             TEXT PRIMARY KEY,
  board_id       TEXT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
  structure_hash TEXT NOT NULL,
  dialect        TEXT NOT NULL,
  host           TEXT NOT NULL,
  model          TEXT NOT NULL,
  preset_id      TEXT,
  size           TEXT NOT NULL,
  quality        TEXT,
  prompt_hash    TEXT NOT NULL,
  control_sha256 TEXT NOT NULL,
  file           TEXT,
  sha256         TEXT,
  status         TEXT NOT NULL CHECK (status IN ('candidate', 'adopted', 'rejected')),
  outcome        TEXT NOT NULL,
  usage_json     TEXT,
  ai_label_on    INTEGER NOT NULL DEFAULT 1 CHECK (ai_label_on IN (0, 1)),
  source_type    TEXT NOT NULL DEFAULT 'model_generated',
  created_at     TEXT NOT NULL
) STRICT;
CREATE INDEX idx_board_raster_board ON board_raster(board_id, created_at);

CREATE TABLE schedule_constraint (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  a_setup_id TEXT REFERENCES setup(id) ON DELETE CASCADE,
  b_setup_id TEXT REFERENCES setup(id) ON DELETE CASCADE,
  setup_id   TEXT REFERENCES setup(id) ON DELETE CASCADE,
  at_utc     TEXT,
  start_utc  TEXT,
  end_utc    TEXT,
  confirmed  INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  CHECK (
    (type = 'before' AND a_setup_id IS NOT NULL AND b_setup_id IS NOT NULL)
    OR (type IN ('not_before', 'not_after') AND setup_id IS NOT NULL AND at_utc IS NOT NULL)
    OR (type = 'locked_block' AND setup_id IS NOT NULL AND start_utc IS NOT NULL AND end_utc IS NOT NULL)
  )
) STRICT;

CREATE TABLE plan (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  day_start_utc TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  revision      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_plan_date ON plan(date);

CREATE TABLE take (
  id                     TEXT PRIMARY KEY,
  setup_id               TEXT REFERENCES setup(id) ON DELETE SET NULL,
  take_no                INTEGER NOT NULL CHECK (take_no > 0),
  camera_label           TEXT,
  rating                 TEXT NOT NULL DEFAULT 'unrated' CHECK (rating IN ('good', 'alternate', 'reject', 'unrated')),
  clip_hint              TEXT,
  notes                  TEXT NOT NULL DEFAULT '',
  unresolved_labels_json TEXT NOT NULL DEFAULT '[]',
  logged_at              TEXT NOT NULL,
  revision               INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_take_clip_hint ON take(clip_hint);
CREATE INDEX idx_take_logged ON take(logged_at);

-- take <-> shot, many-to-many (INV-06); sort keeps Take.shot_ids order
CREATE TABLE take_shot (
  take_id TEXT NOT NULL REFERENCES take(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  sort    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (take_id, shot_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_take_shot_shot ON take_shot(shot_id);

CREATE TABLE source_root (
  id         TEXT PRIMARY KEY,
  abs_path   TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE media_asset (
  id                 TEXT PRIMARY KEY,
  source_root_id     TEXT NOT NULL REFERENCES source_root(id),
  rel_path           TEXT NOT NULL,
  size               INTEGER NOT NULL,
  mtime_ms           REAL NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'image', 'other')),
  probe_json         TEXT,
  video_stream_index INTEGER,
  playable_direct    INTEGER NOT NULL DEFAULT 0 CHECK (playable_direct IN (0, 1)),
  is_vfr_suspect     INTEGER NOT NULL DEFAULT 0 CHECK (is_vfr_suspect IN (0, 1)),
  has_timecode       INTEGER NOT NULL DEFAULT 0 CHECK (has_timecode IN (0, 1)),
  sha256             TEXT,
  hash_status        TEXT NOT NULL DEFAULT 'pending' CHECK (hash_status IN ('pending', 'done', 'source_changed', 'failed', 'skipped')),
  poster_path        TEXT,
  availability       TEXT NOT NULL DEFAULT 'online' CHECK (availability IN ('online', 'offline')),
  -- denormalised searchable text (file name, clip hint, …); FR-09: LIKE only, no FTS
  search_text        TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  UNIQUE (source_root_id, rel_path)
) STRICT;
CREATE INDEX idx_media_asset_sha256 ON media_asset(sha256);
CREATE INDEX idx_media_asset_hash_status ON media_asset(hash_status);

-- shot <-> media, many-to-many (INV-06); source_range is the frozen SR structure
CREATE TABLE shot_media_link (
  id                TEXT PRIMARY KEY,
  shot_id           TEXT NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  media_asset_id    TEXT NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  take_id           TEXT REFERENCES take(id) ON DELETE SET NULL,
  source_range_json TEXT NOT NULL CHECK (json_valid(source_range_json)),
  evidence          TEXT NOT NULL CHECK (evidence IN ('R1', 'R2', 'R3', 'manual')),
  status            TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  confirmed_at      TEXT,
  revision          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_shot_media_link_shot ON shot_media_link(shot_id, status);
CREATE INDEX idx_shot_media_link_asset ON shot_media_link(media_asset_id);
CREATE INDEX idx_shot_media_link_take ON shot_media_link(take_id);

-- append-only human decisions (FR-09)
CREATE TABLE coverage_decision (
  id                     TEXT PRIMARY KEY,
  shot_id                TEXT NOT NULL REFERENCES shot(id),
  decision               TEXT NOT NULL CHECK (decision IN ('usable', 'needs_pickup', 'clear')),
  selected_link_ids_json TEXT NOT NULL DEFAULT '[]',
  reason                 TEXT NOT NULL CHECK (length(reason) > 0),
  basis_content_hash     TEXT NOT NULL,
  at                     TEXT NOT NULL
) STRICT;
CREATE INDEX idx_coverage_decision_shot ON coverage_decision(shot_id, at);
CREATE TRIGGER coverage_decision_no_update BEFORE UPDATE ON coverage_decision
BEGIN SELECT RAISE(ABORT, 'coverage_decision is append-only'); END;
CREATE TRIGGER coverage_decision_no_delete BEFORE DELETE ON coverage_decision
BEGIN SELECT RAISE(ABORT, 'coverage_decision is append-only'); END;

CREATE TABLE job (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  remote          INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0, 1)),
  status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  input_hash      TEXT NOT NULL,
  progress        REAL,
  error_json      TEXT,
  usage_json      TEXT,
  result_ref      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;
CREATE INDEX idx_job_status ON job(status, created_at);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
`;
