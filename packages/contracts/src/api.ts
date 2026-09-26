import { z } from 'zod';
import { JobAccepted, Uuid } from './common.ts';
import { Entity, EntityType } from './entity.ts';
import { Job } from './job.ts';
import { CreateProjectInput, Project, RecentProject } from './project.ts';
import { ParsedScript, Scene, ScreenSides, ScriptFormat, ScriptVersion } from './script.ts';
import { RequiredStatus, Shot, ShotDraft, ShotFields, ShotRevision } from './shot.ts';

/**
 * Local REST API (prefix /api/v1). Internal, not a stable public API.
 * Success: { data }, error: ApiError envelope (common.ts).
 * Path params use `:name`. Collections are small (A-07 scale), so list
 * endpoints return everything and filtering happens client-side.
 * New routes are added here by the lead, milestone by milestone.
 */

// ---------------------------------------------------------------- M0 -------

export const SessionInput = z.object({ token: z.string().min(16) });
export type SessionInput = z.infer<typeof SessionInput>;

export const ToolStatus = z.object({
  path: z.string().nullable(),
  version: z.string().nullable(),
});
export type ToolStatus = z.infer<typeof ToolStatus>;

export const HealthInfo = z.object({
  app_version: z.string(),
  node: z.string(),
  sqlite: z.string(),
  ffmpeg: ToolStatus,
  ffprobe: ToolStatus,
  encoders: z.array(z.string()),
  project_open: z.boolean(),
  text_provider_configured: z.boolean(),
  image_provider_configured: z.boolean(),
  demo: z.boolean(),
});
export type HealthInfo = z.infer<typeof HealthInfo>;

export const OpenProjectInput = z.object({ dir: z.string().min(1) });
export type OpenProjectInput = z.infer<typeof OpenProjectInput>;

export const ChooseFolderResult = z.object({ path: z.string().nullable() });
export type ChooseFolderResult = z.infer<typeof ChooseFolderResult>;

// ---------------------------------------------------------------- M3 -------

/** Where a provider setting currently comes from. Keys never leave the server. */
export const SettingSource = z.enum(['env', 'file']);

export const TextProviderView = z.object({
  base_url: z.string(),
  model: z.string(),
  /** last 4 characters of the key, or null when unset */
  key_last4: z.string().nullable(),
  source: SettingSource,
});
export type TextProviderView = z.infer<typeof TextProviderView>;

export const ProvidersView = z.object({
  text: TextProviderView.nullable(),
  /** filled in M8 */
  image: z.null(),
});
export type ProvidersView = z.infer<typeof ProvidersView>;

export const SaveTextProviderInput = z.object({
  base_url: z.url(),
  model: z.string().min(1),
  /** omitted/null = keep the stored key; "" = clear it */
  api_key: z.string().nullable().optional(),
});
export type SaveTextProviderInput = z.infer<typeof SaveTextProviderInput>;

export const ProviderTestResult = z.object({
  ok: z.boolean(),
  /** GET {base}/models answered (free check, no tokens spent) */
  models_endpoint: z.boolean(),
  /** configured model id found in /models; null when the list is unavailable */
  model_listed: z.boolean().nullable(),
  message: z.string(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResult>;

export const HeadingOverride = z.object({
  /** 1-based raw line number */
  line: z.number().int().positive(),
  is_heading: z.boolean(),
});
export type HeadingOverride = z.infer<typeof HeadingOverride>;

export const ScriptInput = z.object({
  text: z.string().min(1).max(2_000_000),
  source_name: z.string().min(1),
  format: ScriptFormat,
  heading_overrides: z.array(HeadingOverride),
});
export type ScriptInput = z.infer<typeof ScriptInput>;

export const ScriptPreview = ParsedScript.extend({
  /** 1-based line numbers the rules detected as scene headings */
  detected_heading_lines: z.array(z.number().int().positive()),
});
export type ScriptPreview = z.infer<typeof ScriptPreview>;

export const ScriptImportResult = z.object({
  version: ScriptVersion,
  scenes: z.array(Scene),
  /** shots whose quote could not be re-found verbatim in the new version */
  needs_relink_shot_ids: z.array(Uuid),
});
export type ScriptImportResult = z.infer<typeof ScriptImportResult>;

export const CurrentScript = z.object({
  version: ScriptVersion,
  scenes: z.array(Scene),
});
export type CurrentScript = z.infer<typeof CurrentScript>;

export const ScriptVersionSummary = z.object({
  id: Uuid,
  source_name: z.string(),
  content_hash: z.string(),
  created_at: z.string(),
  scene_count: z.number().int(),
});

export const UpdateSceneInput = z.object({
  screen_sides: ScreenSides.nullable().optional(),
  location_entity_id: Uuid.nullable().optional(),
});

export const CreateEntityInput = z.object({
  type: EntityType,
  name: z.string().min(1),
  aliases: z.array(z.string()),
});
export const UpdateEntityInput = z.object({
  name: z.string().min(1).optional(),
  aliases: z.array(z.string()).optional(),
  confirmed: z.boolean().optional(),
});

export const EntityDraftSelection = z.object({
  items: z.array(
    z.object({
      kind: z.enum(['characters', 'locations', 'props']),
      index: z.number().int().nonnegative(),
      /** user edits before applying */
      name: z.string().min(1),
      aliases: z.array(z.string()),
    }),
  ),
});

export const CreateShotInput = z.object({
  scene_id: Uuid,
  fields: ShotFields,
  /** required for manual shots (SPEC FR-03) */
  manual_note: z.string().min(1),
  code: z.string().min(1).optional(),
});

export const UpdateShotInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  fields: ShotFields.optional(),
  code: z.string().min(1).optional(),
  locked: z.boolean().optional(),
  reason: z.string().optional(),
});

export const ArchiveShotInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  reason: z.string().min(1),
});

/** waive / restore (SPEC §5.9: waived lives only on Shot.required_status) */
export const SetRequirementInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  required_status: RequiredStatus,
  reason: z.string().min(1),
});

export const NarrativeOrderInput = z.object({
  scene_id: Uuid,
  shot_ids: z.array(Uuid),
});

export const BreakdownRequest = z.object({
  technique_id: z.string().nullable(),
  reference_note: z.string().max(500).nullable(),
  max_shots: z.number().int().min(1).max(40),
  target_seconds: z.number().int().positive().nullable(),
});
export type BreakdownRequest = z.infer<typeof BreakdownRequest>;

/** Draft plus what the diff view needs about the scene's current shots. */
export const DraftDetail = z.object({
  draft: ShotDraft,
  /** for breakdown drafts: current shots of the scope scene */
  current_shots: z.array(Shot),
  /** claim flags found in model text (annotate only) */
  claim_flags: z.array(z.object({ item: z.number().int().nullable(), kind: z.string(), text: z.string() })),
});
export type DraftDetail = z.infer<typeof DraftDetail>;

export const ApplyBreakdownInput = z.object({
  /** indices into draft.parsed.shots */
  selected: z.array(z.number().int().nonnegative()),
  /** archive unlocked AI shots of this scene that are not kept */
  replace_existing: z.boolean(),
  /** optimistic concurrency for every existing shot that may be archived */
  expected_revisions: z.record(z.string(), z.number().int().nonnegative()),
});

export const ApplyBreakdownResult = z.object({
  created: z.array(Shot),
  archived_ids: z.array(Uuid),
  skipped_locked_ids: z.array(Uuid),
});
export type ApplyBreakdownResult = z.infer<typeof ApplyBreakdownResult>;

// -------------------------------------------------------------- registry ---

export const Api = {
  // M0
  session: { method: 'POST', path: '/api/v1/session', input: SessionInput },
  health: { method: 'GET', path: '/api/v1/health', output: HealthInfo },
  recentProjects: { method: 'GET', path: '/api/v1/projects/recent', output: z.array(RecentProject) },
  createProject: { method: 'POST', path: '/api/v1/projects', input: CreateProjectInput, output: Project },
  openProject: { method: 'POST', path: '/api/v1/projects/open', input: OpenProjectInput, output: Project },
  closeProject: { method: 'POST', path: '/api/v1/projects/close' },
  currentProject: { method: 'GET', path: '/api/v1/project', output: Project },
  chooseFolder: { method: 'POST', path: '/api/v1/platform/choose-folder', output: ChooseFolderResult },

  // M3 — settings
  getProviders: { method: 'GET', path: '/api/v1/settings/providers', output: ProvidersView },
  saveTextProvider: { method: 'PUT', path: '/api/v1/settings/providers/text', input: SaveTextProviderInput, output: ProvidersView },
  testTextProvider: { method: 'POST', path: '/api/v1/settings/providers/text/test', output: ProviderTestResult },

  // M3 — script
  previewScript: { method: 'POST', path: '/api/v1/scripts/preview', input: ScriptInput, output: ScriptPreview },
  importScript: { method: 'POST', path: '/api/v1/scripts', input: ScriptInput, output: ScriptImportResult },
  currentScript: { method: 'GET', path: '/api/v1/scripts/current', output: CurrentScript.nullable() },
  scriptVersions: { method: 'GET', path: '/api/v1/scripts/versions', output: z.array(ScriptVersionSummary) },
  updateScene: { method: 'PATCH', path: '/api/v1/scenes/:id', input: UpdateSceneInput, output: Scene },

  // M3 — entities
  listEntities: { method: 'GET', path: '/api/v1/entities', output: z.array(Entity) },
  createEntity: { method: 'POST', path: '/api/v1/entities', input: CreateEntityInput, output: Entity },
  updateEntity: { method: 'PATCH', path: '/api/v1/entities/:id', input: UpdateEntityInput, output: Entity },
  extractEntities: { method: 'POST', path: '/api/v1/entities/extract', output: JobAccepted },
  applyEntityDraft: { method: 'POST', path: '/api/v1/drafts/:id/apply-entities', input: EntityDraftSelection, output: z.array(Entity) },

  // M3 — shots
  listShots: { method: 'GET', path: '/api/v1/shots', output: z.array(Shot) },
  createShot: { method: 'POST', path: '/api/v1/shots', input: CreateShotInput, output: Shot },
  updateShot: { method: 'PATCH', path: '/api/v1/shots/:id', input: UpdateShotInput, output: Shot },
  archiveShot: { method: 'POST', path: '/api/v1/shots/:id/archive', input: ArchiveShotInput, output: Shot },
  setRequirement: { method: 'POST', path: '/api/v1/shots/:id/requirement', input: SetRequirementInput, output: Shot },
  setNarrativeOrder: { method: 'PUT', path: '/api/v1/shots/narrative-order', input: NarrativeOrderInput, output: z.array(Shot) },
  shotRevisions: { method: 'GET', path: '/api/v1/shots/:id/revisions', output: z.array(ShotRevision) },

  // M3 — AI breakdown & drafts
  requestBreakdown: { method: 'POST', path: '/api/v1/scenes/:id/breakdown', input: BreakdownRequest, output: JobAccepted },
  listDrafts: { method: 'GET', path: '/api/v1/drafts', output: z.array(ShotDraft) },
  getDraft: { method: 'GET', path: '/api/v1/drafts/:id', output: DraftDetail },
  applyBreakdown: { method: 'POST', path: '/api/v1/drafts/:id/apply', input: ApplyBreakdownInput, output: ApplyBreakdownResult },
  discardDraft: { method: 'POST', path: '/api/v1/drafts/:id/discard', output: ShotDraft },

  // M3 — jobs
  getJob: { method: 'GET', path: '/api/v1/jobs/:id', output: Job },
  listActiveJobs: { method: 'GET', path: '/api/v1/jobs', output: z.array(Job) },
  cancelJob: { method: 'POST', path: '/api/v1/jobs/:id/cancel', output: Job },
} as const;
