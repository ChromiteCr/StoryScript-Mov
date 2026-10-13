import type { ShotTip, ShotTipsView } from '@storyscript/contracts';
import { ruleTips, timeOfDay } from '@storyscript/core';
import { actorResolver } from '../collab/actor.ts';
import type { DbPort } from '../db/port.ts';
import { listActiveShots } from '../db/repos/shot.ts';
import { listTips } from '../db/repos/tips.ts';
import { projectBoardContext } from './boards/context.ts';

/**
 * S5c: the tips of every live shot — the model's when it wrote some (stale
 * when the shot's content hash moved on), else a first guess from the shot's
 * fields and its scene's time of day.
 */
export function shotTipsView(db: DbPort): ShotTipsView {
  const rows = new Map(listTips(db).map((r) => [r.shot_id, r] as const));
  const who = actorResolver(db);
  const pc = projectBoardContext(db);
  const times = new Map<string, ReturnType<typeof timeOfDay>>();
  const timeOf = (sceneId: string) => {
    if (!times.has(sceneId)) times.set(sceneId, timeOfDay(pc.timeLabel(sceneId)));
    return times.get(sceneId)!;
  };
  const tips: ShotTip[] = listActiveShots(db).map((s) => {
    const r = rows.get(s.id);
    if (r) {
      return {
        shot_id: s.id,
        difficulty: r.difficulty,
        gear: r.gear,
        tips: r.tips,
        mistake: r.mistake,
        source: 'ai',
        stale: r.basis_hash !== s.content_hash,
        created_at: r.created_at,
        actor: who(r.actor_id),
        prompt_version: r.prompt_version,
      };
    }
    const guess = ruleTips(s.fields, timeOf(s.scene_id));
    return { shot_id: s.id, difficulty: guess.difficulty, gear: guess.gear, tips: [], mistake: null, source: 'rule', stale: false, created_at: null, actor: null, prompt_version: null };
  });
  return { tips };
}
