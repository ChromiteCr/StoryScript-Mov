/**
 * 009 — S5c 镜头拍摄提示:
 *   shot_tip  the model's tips for one shot (difficulty, gear, 2–3 tips, a
 *             common mistake), written per scene by a shot_tips job; one row
 *             per shot, replaced by the next run. basis_hash is the shot's
 *             content hash the model saw: a shot changed since reads as stale.
 */
export const SHOT_TIPS_SQL = `
CREATE TABLE shot_tip (
  shot_id         TEXT PRIMARY KEY REFERENCES shot(id) ON DELETE CASCADE,
  scene_id        TEXT NOT NULL,
  basis_hash      TEXT NOT NULL,
  difficulty      TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  gear_json       TEXT NOT NULL DEFAULT '[]',
  tips_json       TEXT NOT NULL DEFAULT '[]',
  mistake         TEXT NOT NULL,
  job_id          TEXT,
  model           TEXT,
  prompt_version  TEXT NOT NULL,
  actor_id        TEXT,
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX idx_shot_tip_scene ON shot_tip(scene_id);
`;
