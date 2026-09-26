import { z } from 'zod';
import { JobAccepted, Uuid } from './common.ts';
import { Entity, EntityType } from './entity.ts';
import { Job } from './job.ts';
import { CreateProjectInput, Project, RecentProject } from './project.ts';
import { ParsedScript, Scene, ScreenSides, ScriptFormat, ScriptVersion } from './script.ts';
import { RequiredStatus, Shot, ShotDraft, ShotFields, ShotRevision } from './shot.ts';
import { CoverageDecision, CoverageDecisionKind, CoverageResult } from './coverage.ts';
import { LinkCandidate, MediaAsset, ShotMediaLink, SourceRoot } from './media.ts';
import { Constraint, Plan, Resource, ResourceType, Setup, SetupDurations, TimeWindow, Violation } from './plan.ts';
import { Take, TakeRating } from './take.ts';

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


// ---------------------------------------------------------------- M5 -------
// Times are UTC instants; the web converts local wall-clock input with
// core/schedule localToUtc / localWindowToUtc using the project time zone.
// Resource.cast_character_ids maps a performer to character entities and a
// location resource to location entities (scene.location_entity_id).

export const CreateResourceInput = z.object({
  type: ResourceType,
  name: z.string().min(1),
  windows: z.array(TimeWindow),
  cast_character_ids: z.array(Uuid),
  confirmed: z.boolean(),
});
export const UpdateResourceInput = CreateResourceInput.partial();

export const CreateSetupInput = z.object({
  location_resource_id: Uuid.nullable(),
  label: z.string().min(1),
  shot_ids: z.array(Uuid),
  resource_ids: z.array(Uuid),
  durations: SetupDurations,
  estimate_confirmed: z.boolean(),
});
export const UpdateSetupInput = CreateSetupInput.partial();

/** Auto-group active shots into setups: same location resource + camera angle/facing bucket. */
export const DeriveSetupsInput = z.object({
  /** keep setups the user created or edited; only rebuild auto ones */
  keep_edited: z.boolean(),
  default_durations: SetupDurations,
});

export const ConstraintInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('before'), a_setup_id: Uuid, b_setup_id: Uuid, confirmed: z.boolean() }),
  z.object({ type: z.literal('not_before'), setup_id: Uuid, at_utc: z.string(), confirmed: z.boolean() }),
  z.object({ type: z.literal('not_after'), setup_id: Uuid, at_utc: z.string(), confirmed: z.boolean() }),
  z.object({ type: z.literal('locked_block'), setup_id: Uuid, start_utc: z.string(), end_utc: z.string(), confirmed: z.boolean() }),
]);

export const CreatePlanInput = z.object({
  /** local shooting date YYYY-MM-DD in the project time zone */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** crew call and wrap, local HH:mm; wrap ≤ call means past midnight */
  crew_call: z.string().regex(/^\d{2}:\d{2}$/),
  crew_wrap: z.string().regex(/^\d{2}:\d{2}$/),
});

export const PlanDetail = z.object({
  plan: Plan,
  /** input changed since the plan was computed */
  stale: z.boolean(),
  approval: z.object({ ok: z.boolean(), blockers: z.array(Violation) }),
});
export type PlanDetail = z.infer<typeof PlanDetail>;

export const PlanRevisionInput = z.object({ expected_revision: z.number().int().nonnegative() });
export const ReorderPlanInput = PlanRevisionInput.extend({ order: z.array(Uuid) });
export const AdoptSuggestionInput = PlanRevisionInput.extend({ draft_id: Uuid });

// ---------------------------------------------------------------- M6 -------

export const CreateTakeInput = z.object({
  setup_id: Uuid.nullable(),
  /** omitted = next number for this shot set */
  take_no: z.number().int().positive().optional(),
  camera_label: z.string().nullable(),
  rating: TakeRating,
  clip_hint: z.string().nullable(),
  notes: z.string(),
  shot_ids: z.array(Uuid),
  unresolved_labels: z.array(z.string()),
});
export const UpdateTakeInput = CreateTakeInput.partial().extend({
  expected_revision: z.number().int().nonnegative(),
  /** why a logged fact was corrected (audit) */
  reason: z.string().min(1),
});

export const AddRootInput = z.object({ abs_path: z.string().min(1), label: z.string().optional() });

/** Asset row for the library: asset + where it lives + review hints. */
export const MediaAssetView = MediaAsset.extend({
  root_label: z.string(),
  /** same-origin URL of the poster JPEG, null when none */
  poster_url: z.string().nullable(),
  /** same-origin Range-capable URL, null unless playable_direct */
  stream_url: z.string().nullable(),
  link_count: z.number().int().nonnegative(),
  candidate_count: z.number().int().nonnegative(),
});
export type MediaAssetView = z.infer<typeof MediaAssetView>;

export const MediaSearchInput = z.object({
  q: z.string(),
  availability: z.enum(['online', 'offline']).nullable(),
  linked: z.enum(['linked', 'unlinked', 'candidate']).nullable(),
});

export const RootCheckResult = z.object({ online: z.number().int(), offline: z.number().int(), changed: z.number().int() });

export const BuildCandidatesInput = z.object({ user_regex: z.string().nullable() });
export const BuildCandidatesOutput = z.object({
  created: z.array(ShotMediaLink),
  candidates: z.array(LinkCandidate),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const CreateLinkInput = z.object({
  shot_id: Uuid,
  media_asset_id: Uuid,
  take_id: Uuid.nullable(),
});
export const ReviewLinkInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  action: z.enum(['confirm', 'reject', 'unlink']),
});

export const CoverageDecisionInput = z.object({
  decision: CoverageDecisionKind,
  selected_link_ids: z.array(Uuid),
  reason: z.string().min(1),
});

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
  // M5 — resources, setups, constraints, plans
  listResources: { method: 'GET', path: '/api/v1/resources', output: z.array(Resource) },
  createResource: { method: 'POST', path: '/api/v1/resources', input: CreateResourceInput, output: Resource },
  updateResource: { method: 'PATCH', path: '/api/v1/resources/:id', input: UpdateResourceInput, output: Resource },
  deleteResource: { method: 'DELETE', path: '/api/v1/resources/:id', output: z.object({ id: Uuid }) },
  listSetups: { method: 'GET', path: '/api/v1/setups', output: z.array(Setup) },
  deriveSetups: { method: 'POST', path: '/api/v1/setups/derive', input: DeriveSetupsInput, output: z.array(Setup) },
  createSetup: { method: 'POST', path: '/api/v1/setups', input: CreateSetupInput, output: Setup },
  updateSetup: { method: 'PATCH', path: '/api/v1/setups/:id', input: UpdateSetupInput, output: Setup },
  deleteSetup: { method: 'DELETE', path: '/api/v1/setups/:id', output: z.object({ id: Uuid }) },
  listConstraints: { method: 'GET', path: '/api/v1/constraints', output: z.array(Constraint) },
  createConstraint: { method: 'POST', path: '/api/v1/constraints', input: ConstraintInput, output: Constraint },
  deleteConstraint: { method: 'DELETE', path: '/api/v1/constraints/:id', output: z.object({ id: Uuid }) },
  listPlans: { method: 'GET', path: '/api/v1/plans', output: z.array(Plan) },
  createPlan: { method: 'POST', path: '/api/v1/plans', input: CreatePlanInput, output: PlanDetail },
  getPlan: { method: 'GET', path: '/api/v1/plans/:id', output: PlanDetail },
  recomputePlan: { method: 'POST', path: '/api/v1/plans/:id/recompute', input: PlanRevisionInput, output: PlanDetail },
  reorderPlan: { method: 'POST', path: '/api/v1/plans/:id/reorder', input: ReorderPlanInput, output: PlanDetail },
  approvePlan: { method: 'POST', path: '/api/v1/plans/:id/approve', input: PlanRevisionInput, output: PlanDetail },
  suggestOrder: { method: 'POST', path: '/api/v1/plans/:id/suggest-order', output: JobAccepted },
  adoptSuggestion: { method: 'POST', path: '/api/v1/plans/:id/adopt-suggestion', input: AdoptSuggestionInput, output: PlanDetail },

  // M6 — takes, media, links, coverage
  listTakes: { method: 'GET', path: '/api/v1/takes', output: z.array(Take) },
  createTake: { method: 'POST', path: '/api/v1/takes', input: CreateTakeInput, output: Take },
  updateTake: { method: 'PATCH', path: '/api/v1/takes/:id', input: UpdateTakeInput, output: Take },
  listRoots: { method: 'GET', path: '/api/v1/media/roots', output: z.array(SourceRoot) },
  addRoot: { method: 'POST', path: '/api/v1/media/roots', input: AddRootInput, output: SourceRoot },
  scanRoot: { method: 'POST', path: '/api/v1/media/roots/:id/scan', output: JobAccepted },
  checkRoot: { method: 'POST', path: '/api/v1/media/roots/:id/check', output: RootCheckResult },
  listAssets: { method: 'GET', path: '/api/v1/media/assets', output: z.array(MediaAssetView) },
  searchAssets: { method: 'POST', path: '/api/v1/media/search', input: MediaSearchInput, output: z.array(MediaAssetView) },
  buildCandidates: { method: 'POST', path: '/api/v1/media/candidates', input: BuildCandidatesInput, output: BuildCandidatesOutput },
  listLinks: { method: 'GET', path: '/api/v1/links', output: z.array(ShotMediaLink) },
  createLink: { method: 'POST', path: '/api/v1/links', input: CreateLinkInput, output: ShotMediaLink },
  reviewLink: { method: 'PATCH', path: '/api/v1/links/:id', input: ReviewLinkInput, output: ShotMediaLink },
  coverage: { method: 'GET', path: '/api/v1/coverage', output: z.array(CoverageResult) },
  addCoverageDecision: { method: 'POST', path: '/api/v1/shots/:id/coverage-decisions', input: CoverageDecisionInput, output: CoverageDecision },
} as const;
