import { z } from 'zod';
import { IsoTime } from './common.ts';
import { CameraAngle, LensClass, Movement, ShotSize } from './shot.ts';

// ---------------------------------------------------------------------------
// S3 — style cards: a camera language (movement, lenses, framing, rhythm)
// the breakdown and polish prompts follow. Built-in cards ship in core and
// are named after the technique, never after a person or a film
// (docs/CLEANROOM.md §3); a group's own cards live in its project. A
// researched card keeps the reference the user typed (their data) and is
// always marked unverified.
// ---------------------------------------------------------------------------

/** How ambitious the shots may be: 稳妥 / 进取 / 挑战. */
export const StyleLevel = z.enum(['steady', 'bold', 'extreme']);
export type StyleLevel = z.infer<typeof StyleLevel>;

export const StyleOrigin = z.enum(['builtin', 'custom', 'researched']);
export type StyleOrigin = z.infer<typeof StyleOrigin>;

/** Values the style leans toward (a hint to the model, not a rule). */
export const StyleBias = z.object({
  shot_size: z.array(ShotSize),
  angle: z.array(CameraAngle),
  lens: z.array(LensClass),
  movement: z.array(Movement),
});
export type StyleBias = z.infer<typeof StyleBias>;

export const STYLE_LIMITS = { name: 24, summary: 80, grammar: 800, gear: 300, low_budget: 300, reference: 200 } as const;

export const StyleCard = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(STYLE_LIMITS.name),
  summary: z.string().max(STYLE_LIMITS.summary),
  /** the camera language itself: movement, lenses, framing, rhythm */
  grammar: z.string().min(1).max(STYLE_LIMITS.grammar),
  bias: StyleBias,
  /** gear and hands the style needs */
  gear: z.string().max(STYLE_LIMITS.gear),
  /** how to get close with a phone and a gimbal */
  low_budget: z.string().max(STYLE_LIMITS.low_budget),
  origin: StyleOrigin,
  /** researched cards: what the user asked about, verbatim */
  reference: z.string().max(STYLE_LIMITS.reference).nullable(),
  /** researched cards: a general-technique summary, not checked against any film */
  unverified: z.boolean(),
  created_at: IsoTime.nullable(),
  updated_at: IsoTime.nullable(),
  /** S4a: bumped by every change; updates may name the one they started from */
  revision: z.number().int().nonnegative().optional(),
});
export type StyleCard = z.infer<typeof StyleCard>;

export const StyleCardInput = z.object({
  name: z.string().trim().min(1).max(STYLE_LIMITS.name),
  summary: z.string().trim().max(STYLE_LIMITS.summary),
  grammar: z.string().trim().min(1).max(STYLE_LIMITS.grammar),
  bias: StyleBias,
  gear: z.string().trim().max(STYLE_LIMITS.gear),
  low_budget: z.string().trim().max(STYLE_LIMITS.low_budget),
  /** S4a (updates): the revision the edit started from; an older one is refused */
  expected_revision: z.number().int().nonnegative().optional(),
});
export type StyleCardInput = z.infer<typeof StyleCardInput>;

/** The group's defaults for new breakdowns and polish requests. */
export const StyleDefaults = z.object({
  style_id: z.string().nullable(),
  level: StyleLevel,
});
export type StyleDefaults = z.infer<typeof StyleDefaults>;

export const StyleLibrary = z.object({
  /** built-in cards first, then the group's own */
  cards: z.array(StyleCard),
  defaults: StyleDefaults,
});
export type StyleLibrary = z.infer<typeof StyleLibrary>;

export const StyleResearchInput = z.object({
  /** e.g. a director and film, an ad, a photographer, or a description */
  reference: z.string().trim().min(2).max(STYLE_LIMITS.reference),
  notes: z.string().trim().max(300).nullable(),
});
export type StyleResearchInput = z.infer<typeof StyleResearchInput>;

/** LLM output of a style research call. Flat, all keys required (provider-portable schema). */
export const StyleResearchOutput = z.object({
  name: z.string(),
  summary: z.string(),
  grammar: z.string(),
  shot_size_bias: z.array(ShotSize),
  angle_bias: z.array(CameraAngle),
  lens_bias: z.array(LensClass),
  movement_bias: z.array(Movement),
  gear: z.string(),
  low_budget: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  caveats: z.array(z.string()),
});
export type StyleResearchOutput = z.infer<typeof StyleResearchOutput>;
