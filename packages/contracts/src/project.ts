import { z } from 'zod';
import { IsoTime, Uuid } from './common.ts';
import { FrameFormat } from './shot.ts';

export const PROJECT_SCHEMA_VERSION = 3;

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

export const PROJECT_EXPORT_FORMAT = 'storyscript-mov-export';
export const PROJECT_EXPORT_VERSION = '1.0.0';

/**
 * Project JSON export (SPEC FR-10). Everything needed to understand and
 * re-link the project, never the original media, API keys or private logs.
 * Source roots carry only a label (absolute paths are private); media assets
 * carry root label + relative path + content hash for re-linking. Collections
 * are validated with the same contracts as the API (kept loose here to avoid
 * a circular import graph; the server builds it from typed repos).
 */
export const ProjectExport = z.object({
  format: z.literal(PROJECT_EXPORT_FORMAT),
  export_version: z.string(),
  schema_version: z.number().int().positive(),
  exported_at: IsoTime,
  app_version: z.string(),
  project: Project,
  script_versions: z.array(z.unknown()),
  scenes: z.array(z.unknown()),
  entities: z.array(z.unknown()),
  shots: z.array(z.unknown()),
  shot_revisions: z.array(z.unknown()),
  boards: z.array(z.unknown()),
  board_rasters: z.array(z.unknown()),
  techniques: z.array(z.unknown()),
  resources: z.array(z.unknown()),
  setups: z.array(z.unknown()),
  constraints: z.array(z.unknown()),
  plans: z.array(z.unknown()),
  takes: z.array(z.unknown()),
  source_roots: z.array(z.object({ id: Uuid, label: z.string() })),
  media_assets: z.array(z.unknown()),
  shot_media_links: z.array(z.unknown()),
  coverage_decisions: z.array(z.unknown()),
});
export type ProjectExport = z.infer<typeof ProjectExport>;
