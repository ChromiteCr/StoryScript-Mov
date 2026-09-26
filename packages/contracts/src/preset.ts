import { z } from 'zod';
import { CameraAngle, FrameFormat, LensClass, Movement, ShotSize } from './shot.ts';

/** Evidence basis of a technique card. Shown as a badge; never implies endorsement. */
export const BasisType = z.enum(['interview', 'analysis', 'general']);
export type BasisType = z.infer<typeof BasisType>;

export const TechniqueSource = z.object({
  title: z.string(),
  url: z.string().nullable(),
  basis_type: BasisType,
});
export type TechniqueSource = z.infer<typeof TechniqueSource>;

/** Camera defaults a technique pushes onto layout (all optional overrides). */
export const CameraDefaults = z.object({
  focal_mm: z.number().nullable(),
  camera_height_m: z.number().nullable(),
  pitch_deg: z.number().nullable(),
  shot_size_bias: z.array(ShotSize),
  angle_bias: z.array(CameraAngle),
  lens_bias: z.array(LensClass),
  movement_bias: z.array(Movement),
});
export type CameraDefaults = z.infer<typeof CameraDefaults>;

export const Technique = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  intended_effect: z.string(),
  /** prose guidance injected into the breakdown prompt */
  shot_grammar: z.string(),
  camera_defaults: CameraDefaults,
  applicable_scenes: z.string(),
  resource_cost_notes: z.string(),
  low_budget_alternative: z.string(),
  sources: z.array(TechniqueSource),
  limitations: z.string(),
  builtin: z.boolean(),
});
export type Technique = z.infer<typeof Technique>;

/** Look preset: how boards are drawn (the pencil renderer + default framing). */
export const LookPreset = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  default_aspect: FrameFormat,
  center_guide: z.boolean(),
  /** set_piece shots default to low-angle wide framing */
  set_piece_low_wide: z.boolean(),
  pencil: z.object({
    hatch_angle_deg: z.number(),
    paper_tone: z.string(),
    outline_px: z.object({ fg: z.number(), mg: z.number(), bg: z.number() }),
  }),
});
export type LookPreset = z.infer<typeof LookPreset>;
