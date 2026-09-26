import { z } from 'zod';
import { IsoTime, Origin, Uuid } from './common.ts';

export const ScriptFormat = z.enum(['paste', 'txt', 'md', 'fountain']);
export type ScriptFormat = z.infer<typeof ScriptFormat>;

/** Paragraph anchor id, `p-001` … */
export const ParagraphId = z.string().regex(/^p-\d{3,}$/);
export type ParagraphId = z.infer<typeof ParagraphId>;

export const Paragraph = z.object({
  id: ParagraphId,
  text: z.string(),
  /** 1-based line number of the first line in the raw text */
  line: z.number().int().positive(),
  is_heading: z.boolean(),
  /** index into the scene list of this version; null before the first heading */
  scene_idx: z.number().int().nonnegative().nullable(),
});
export type Paragraph = z.infer<typeof Paragraph>;

export const ScriptVersion = z.object({
  id: Uuid,
  parent_id: Uuid.nullable(),
  source_name: z.string(),
  format: ScriptFormat,
  content_hash: z.string(),
  raw_text: z.string(),
  paragraphs: z.array(Paragraph),
  created_at: IsoTime,
});
export type ScriptVersion = z.infer<typeof ScriptVersion>;

/** Which character alias occupies screen-left / screen-right in this scene (180° axis). */
export const ScreenSides = z.object({
  left: z.string().nullable(),
  right: z.string().nullable(),
});
export type ScreenSides = z.infer<typeof ScreenSides>;

export const Scene = z.object({
  id: Uuid,
  script_version_id: Uuid,
  display_no: z.string(),
  heading: z.string(),
  paragraph_ids: z.array(ParagraphId),
  location_entity_id: Uuid.nullable(),
  time_label: z.string().nullable(),
  screen_sides: ScreenSides.nullable(),
  origin: Origin,
});
export type Scene = z.infer<typeof Scene>;

/** Result of the pure scene splitter in core/script. */
export const ParsedScript = z.object({
  paragraphs: z.array(Paragraph),
  scenes: z.array(
    z.object({
      display_no: z.string(),
      heading: z.string(),
      paragraph_ids: z.array(ParagraphId),
      time_label: z.string().nullable(),
      location_label: z.string().nullable(),
    }),
  ),
});
export type ParsedScript = z.infer<typeof ParsedScript>;
