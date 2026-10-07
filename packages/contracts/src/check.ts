import { z } from 'zod';
import { ActorRef, IsoTime, Uuid } from './common.ts';
import { ParagraphId } from './script.ts';
import { DraftIssue } from './shot.ts';

/**
 * S5 剧本体检: a rule-based length estimate per scene, and the shooting
 * difficulties the group's model finds in the script (a hint list the group
 * ticks off; nothing here changes the script or the shots).
 */

// ------------------------------------------------------------ length estimate

export const SceneIntExt = z.enum(['int', 'ext', 'int_ext']);
export type SceneIntExt = z.infer<typeof SceneIntExt>;

export const SceneEstimate = z.object({
  scene_id: Uuid,
  display_no: z.string(),
  heading: z.string(),
  /** rough screen time from the text, whole seconds */
  seconds: z.number().int().nonnegative(),
  /** counted units (a CJK character, or 1.5 per Latin word) */
  dialogue_units: z.number().nonnegative(),
  action_units: z.number().nonnegative(),
  /** sum of est_seconds of the scene's live shots; null without shots */
  shots_seconds: z.number().nonnegative().nullable(),
  int_ext: SceneIntExt.nullable(),
  time_label: z.string().nullable(),
});
export type SceneEstimate = z.infer<typeof SceneEstimate>;

export const ScriptEstimate = z.object({
  seconds: z.number().int().nonnegative(),
  low_seconds: z.number().int().nonnegative(),
  high_seconds: z.number().int().nonnegative(),
  /** the project's target length, when set */
  target_seconds: z.number().int().positive().nullable(),
  scenes: z.array(SceneEstimate),
});
export type ScriptEstimate = z.infer<typeof ScriptEstimate>;

// ------------------------------------------------------- shooting difficulties

export const ScriptRiskCategory = z.enum([
  'night_exterior',
  'rain_water',
  'vehicle',
  'crowd',
  'animal',
  'stunt',
  'permit_location',
  'vfx',
  'period',
]);
export type ScriptRiskCategory = z.infer<typeof ScriptRiskCategory>;

export const ScriptRiskSeverity = z.enum(['low', 'medium', 'high']);
export type ScriptRiskSeverity = z.infer<typeof ScriptRiskSeverity>;

export const RISK_PROBLEM_MAX = 40;
export const RISK_ALTERNATIVE_MAX = 80;
export const RISKS_PER_SCENE_MAX = 4;
export const RISKS_MAX = 60;

/** LLM output of a script check (validated again in core). */
export const ScriptCheckOutput = z.object({
  risks: z
    .array(
      z.object({
        paragraph_id: z.string(),
        category: ScriptRiskCategory,
        severity: ScriptRiskSeverity,
        quote: z.string(),
        problem: z.string(),
        alternative: z.string(),
      }),
    )
    .max(200),
});
export type ScriptCheckOutput = z.infer<typeof ScriptCheckOutput>;
export type ScriptCheckItem = ScriptCheckOutput['risks'][number];

export const ScriptRisk = z.object({
  id: Uuid,
  category: ScriptRiskCategory,
  severity: ScriptRiskSeverity,
  quote: z.string(),
  problem: z.string(),
  alternative: z.string(),
  /** where the quote is in the current script version; null when stale */
  paragraph_id: ParagraphId.nullable(),
  scene_id: Uuid.nullable(),
  /** the script changed and the quote is no longer in it */
  stale: z.boolean(),
  handled: z.object({ at: IsoTime, actor: ActorRef.nullable() }).nullable(),
});
export type ScriptRisk = z.infer<typeof ScriptRisk>;

export const ScriptCheckStatus = z.enum(['done', 'partial']);
export type ScriptCheckStatus = z.infer<typeof ScriptCheckStatus>;

export const ScriptCheckRun = z.object({
  id: Uuid,
  script_version_id: Uuid,
  /** the check was made on the current script version */
  current: z.boolean(),
  status: ScriptCheckStatus,
  model: z.string().nullable(),
  prompt_version: z.string(),
  issues: z.array(DraftIssue),
  created_at: IsoTime,
  actor: ActorRef.nullable(),
});
export type ScriptCheckRun = z.infer<typeof ScriptCheckRun>;

/** GET /api/v1/scripts/check */
export const ScriptCheckView = z.object({
  /** null before a script is imported */
  estimate: ScriptEstimate.nullable(),
  /** the latest check; null before the first one */
  check: ScriptCheckRun.nullable(),
  risks: z.array(ScriptRisk),
});
export type ScriptCheckView = z.infer<typeof ScriptCheckView>;

export const SetRiskHandledInput = z.object({ handled: z.boolean() });
export type SetRiskHandledInput = z.infer<typeof SetRiskHandledInput>;
