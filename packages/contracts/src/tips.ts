import { z } from 'zod';
import { ActorRef, IsoTime, Uuid } from './common.ts';

/**
 * S5c 镜头拍摄提示: for every shot, how hard it is, what to bring and how to
 * shoot it with a phone or entry-level gear. Hints only: nothing here changes
 * a shot. A first guess comes from the shot's fields (no model); the group's
 * model writes tips per scene, which go stale when the shot changes.
 */

export const ShotDifficulty = z.enum(['easy', 'medium', 'hard']);
export type ShotDifficulty = z.infer<typeof ShotDifficulty>;

export const ShotGear = z.enum(['tripod', 'gimbal', 'slider', 'external_mic', 'boom', 'light', 'reflector', 'phone_lens', 'drone', 'car_mount']);
export type ShotGear = z.infer<typeof ShotGear>;

/** characters per tip and per common mistake */
export const TIP_TEXT_MAX = 60;
export const TIPS_MIN = 2;
export const TIPS_MAX = 3;
/** shots of one scene sent in one request */
export const TIP_SHOTS_MAX = 40;

/** LLM output for one scene (validated again in core). */
export const ShotTipsOutput = z.object({
  shots: z
    .array(
      z.object({
        /** s1, s2 … in the order the prompt lists the shots */
        ref: z.string(),
        difficulty: ShotDifficulty,
        gear: z.array(ShotGear),
        tips: z.array(z.string()),
        mistake: z.string(),
      }),
    )
    .max(80),
});
export type ShotTipsOutput = z.infer<typeof ShotTipsOutput>;

export const ShotTipSource = z.enum(['ai', 'rule']);
export type ShotTipSource = z.infer<typeof ShotTipSource>;

export const ShotTip = z.object({
  shot_id: Uuid,
  difficulty: ShotDifficulty,
  gear: z.array(ShotGear),
  /** empty for a rule guess */
  tips: z.array(z.string()),
  mistake: z.string().nullable(),
  source: ShotTipSource,
  /** the shot changed after the model wrote this */
  stale: z.boolean(),
  created_at: IsoTime.nullable(),
  actor: ActorRef.nullable(),
  prompt_version: z.string().nullable(),
});
export type ShotTip = z.infer<typeof ShotTip>;

/** One per live shot. */
export const ShotTipsView = z.object({
  tips: z.array(ShotTip),
});
export type ShotTipsView = z.infer<typeof ShotTipsView>;
