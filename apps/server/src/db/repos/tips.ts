import type { ShotDifficulty, ShotGear } from '@storyscript/contracts';
import { actorId } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/** shot_tip (S5c 镜头拍摄提示): the model's tips for one shot, replaced by the next run for its scene. */

export interface TipRow {
  shot_id: string;
  scene_id: string;
  basis_hash: string;
  difficulty: ShotDifficulty;
  gear: ShotGear[];
  tips: string[];
  mistake: string;
  job_id: string | null;
  model: string | null;
  prompt_version: string;
  actor_id: string | null;
  created_at: string;
}

const COLS = 'shot_id, scene_id, basis_hash, difficulty, gear_json, tips_json, mistake, job_id, model, prompt_version, actor_id, created_at';
type DbRow = Omit<TipRow, 'gear' | 'tips'> & { gear_json: string; tips_json: string };

const fromRow = (r: DbRow): TipRow => {
  const { gear_json, tips_json, ...rest } = r;
  return { ...rest, gear: JSON.parse(gear_json) as ShotGear[], tips: JSON.parse(tips_json) as string[] };
};

export function listTips(db: DbPort): TipRow[] {
  return db.all<DbRow>(`SELECT ${COLS} FROM shot_tip`).map(fromRow);
}

/** Write (or replace) one shot's tips; who asked is the current actor. */
export function upsertTip(db: DbPort, t: Omit<TipRow, 'actor_id'>): void {
  db.run(
    `INSERT INTO shot_tip (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(shot_id) DO UPDATE SET scene_id = excluded.scene_id, basis_hash = excluded.basis_hash, difficulty = excluded.difficulty,
       gear_json = excluded.gear_json, tips_json = excluded.tips_json, mistake = excluded.mistake, job_id = excluded.job_id,
       model = excluded.model, prompt_version = excluded.prompt_version, actor_id = excluded.actor_id, created_at = excluded.created_at`,
    t.shot_id,
    t.scene_id,
    t.basis_hash,
    t.difficulty,
    JSON.stringify(t.gear),
    JSON.stringify(t.tips),
    t.mistake,
    t.job_id,
    t.model,
    t.prompt_version,
    actorId(),
    t.created_at,
  );
}
