import { z } from 'zod';
import { ProbeNormalized } from '@storyscript/contracts';

/**
 * samples/demo-media/media.json — pre-probed metadata of the demo footage.
 * Written by build-media.ts (never at runtime), read by the demo seeder so
 * `--demo` needs neither ffprobe nor ffmpeg: probe facts and the 480px poster
 * come from here, the clip itself (when present) from samples/demo-media/clips.
 */

export const DEMO_MEDIA_FORMAT = 'storyscript-demo-media-v1';
/** clips + posters + manifest together */
export const DEMO_MEDIA_BUDGET_BYTES = 2 * 1024 * 1024;

export const DemoClip = z.object({
  /** path under clips/, "/" separated */
  rel_path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  probe: ProbeNormalized,
  /** path under samples/demo-media/, e.g. posters/S01-001-T01.jpg; null when none */
  poster: z.string().nullable(),
  /** video encoder that produced the clip (for the README table) */
  encoder: z.string().nullable(),
});
export type DemoClip = z.infer<typeof DemoClip>;

export const DemoMediaManifest = z.object({
  format: z.literal(DEMO_MEDIA_FORMAT),
  generated_by: z.string(),
  /** false when the clip files were dropped to stay inside the size budget */
  clips_included: z.boolean(),
  clips: z.array(DemoClip),
});
export type DemoMediaManifest = z.infer<typeof DemoMediaManifest>;
