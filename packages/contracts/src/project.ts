import { z } from 'zod';
import { IsoTime, Uuid } from './common.ts';
import { FrameFormat } from './shot.ts';

export const PROJECT_SCHEMA_VERSION = 1;

/** Contents of `<project>/project.json` (identity only, no secrets). */
export const ProjectManifest = z.object({
  format: z.literal('storyscript-mov-project'),
  id: Uuid,
  schema_version: z.number().int().positive(),
  created_at: IsoTime,
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

export const Project = z.object({
  id: Uuid,
  name: z.string().min(1),
  /** IANA time zone, e.g. Asia/Shanghai */
  timezone: z.string().min(1),
  default_aspect: FrameFormat,
  target_duration_s: z.number().int().positive().nullable(),
  look_preset_id: z.string(),
  /** printf-like slate code format, default "S{scene:02}-{shot:03}-T{take:02}" */
  code_format: z.string(),
  schema_version: z.number().int().positive(),
  created_at: IsoTime,
  updated_at: IsoTime,
});
export type Project = z.infer<typeof Project>;

export const CreateProjectInput = z.object({
  dir: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
  default_aspect: FrameFormat,
  target_duration_s: z.number().int().positive().nullable(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const RecentProject = z.object({
  dir: z.string(),
  name: z.string(),
  opened_at: IsoTime,
});
export type RecentProject = z.infer<typeof RecentProject>;
