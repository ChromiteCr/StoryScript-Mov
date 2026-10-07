/**
 * 007 — S5 剧本体检:
 *   script_check  one check of a script version by the group's model (only
 *                 checks that gave a usable answer are kept); the latest is
 *                 shown, earlier ones stay as history
 *   script_risk   one shooting difficulty of a check, anchored by paragraph
 *                 and quote; any member ticks it off (handled_at/_by), and
 *                 the tick carries over to the same difficulty in a re-check
 */
export const SCRIPT_CHECK_SQL = `
CREATE TABLE script_check (
  id                TEXT PRIMARY KEY,
  script_version_id TEXT NOT NULL REFERENCES script_version(id),
  job_id            TEXT,
  model             TEXT,
  prompt_version    TEXT NOT NULL,
  raw_output        TEXT,
  issues_json       TEXT NOT NULL DEFAULT '[]',
  attempts          INTEGER NOT NULL DEFAULT 0,
  usage_json        TEXT,
  status            TEXT NOT NULL CHECK (status IN ('done', 'partial')),
  actor_id          TEXT,
  created_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_script_check_created ON script_check(created_at);

CREATE TABLE script_risk (
  id           TEXT PRIMARY KEY,
  check_id     TEXT NOT NULL REFERENCES script_check(id) ON DELETE CASCADE,
  sort         INTEGER NOT NULL,
  paragraph_id TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('night_exterior', 'rain_water', 'vehicle', 'crowd', 'animal', 'stunt', 'permit_location', 'vfx', 'period')),
  severity     TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  quote        TEXT NOT NULL,
  problem      TEXT NOT NULL,
  alternative  TEXT NOT NULL,
  handled_at   TEXT,
  handled_by   TEXT
) STRICT;
CREATE INDEX idx_script_risk_check ON script_risk(check_id, sort);
`;
