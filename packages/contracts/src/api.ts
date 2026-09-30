import { z } from 'zod';
import { ActorRef, CrewRoles, JobAccepted, ModelSource, Uuid } from './common.ts';
import { Entity, EntityType } from './entity.ts';
import { Job } from './job.ts';
import { CreateProjectInput, Project, RecentProject } from './project.ts';
import { ParagraphId, ParsedScript, Scene, ScreenSides, ScriptFormat, ScriptVersion } from './script.ts';
import { CameraAngle, Movement, RequiredStatus, Shot, ShotDraft, ShotFields, ShotRevision, ShotSize } from './shot.ts';
import { CoverageDecision, CoverageDecisionKind, CoverageResult } from './coverage.ts';
import { Board, BoardRaster, BoardSpec } from './board.ts';
import { ImageDialect } from './provider.ts';
import { LinkCandidate, MediaAsset, ProbeNormalized, ShotMediaLink, SourceRoot, SourceRootKind } from './media.ts';
import { Constraint, Plan, Resource, ResourceType, Setup, SetupDurations, TimeWindow, Violation } from './plan.ts';
import { StyleCard, StyleCardInput, StyleDefaults, StyleLevel, StyleLibrary, StyleResearchInput } from './style.ts';
import { CastApplyInput, CastSuggestion, CastSyncApplyInput, CastSyncPreview } from './cast.ts';
import { CollabChanges } from './collab.ts';
import { CommentSummary, CreateCommentInput, ShotComment, UpdateCommentInput } from './comments.ts';
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
  /** the user's home directory, so the UI can show paths under it as ~/… ("" on a hosted server) */
  home_dir: z.string(),
  /** hosted server mode: one fixed project per team, footage read in the browser, settings by the admin */
  hosted: z.boolean(),
  /** hosted: the signed-in account's group name */
  team_name: z.string().nullable(),
  /** S4 hosted: whose model this member's AI requests use (null locally); the *_configured flags above follow it */
  text_model_source: ModelSource.nullable().optional(),
  image_model_source: ModelSource.nullable().optional(),
});
export type HealthInfo = z.infer<typeof HealthInfo>;

/** Public (no session needed): what kind of server this is, for the sign-in screen. */
export const SiteInfo = z.object({
  hosted: z.boolean(),
  /** hosted: the site name the admin chose; local: "StoryScript-Mov" */
  name: z.string(),
});
export type SiteInfo = z.infer<typeof SiteInfo>;

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
  /** S3: model for style research (same service and key); null = the main model */
  research_model: z.string().nullable(),
  /** S3: ask the service to search the web during style research, where it supports that */
  research_search: z.boolean(),
  /** which web-search flag this service takes, or null when it has none we know */
  search_support: z.enum(['dashscope', 'openai']).nullable(),
});
export type TextProviderView = z.infer<typeof TextProviderView>;

export const ImageProviderView = z.object({
  base_url: z.string(),
  model: z.string(),
  key_last4: z.string().nullable(),
  source: SettingSource,
  dialect_override: ImageDialect.nullable(),
  /** dialect actually used: override, else detected from the host */
  dialect: ImageDialect,
  /** matched generations-ref preset id (e.g. volcengine-seedream), if any */
  preset_id: z.string().nullable(),
  /** preset verified end-to-end against the real service */
  verified: z.boolean(),
  /** e.g. "Gemini 兼容地址不接收参考图，不能用于草图重绘" */
  warning: z.string().nullable(),
});
export type ImageProviderView = z.infer<typeof ImageProviderView>;

export const ProvidersView = z.object({
  text: TextProviderView.nullable(),
  image: ImageProviderView.nullable(),
  /** S4: false for a group member on the hosted server (only the leader changes the group's model) */
  editable: z.boolean().optional(),
});
export type ProvidersView = z.infer<typeof ProvidersView>;

export const SaveTextProviderInput = z.object({
  base_url: z.url(),
  model: z.string().min(1),
  /** omitted/null = keep the stored key; "" = clear it */
  api_key: z.string().nullable().optional(),
  /** S3: omitted = keep; null or "" = use the main model */
  research_model: z.string().trim().max(100).nullable().optional(),
  /** S3: omitted = keep */
  research_search: z.boolean().optional(),
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

/** S2c: force a line to be (or not be) a shot line */
export const ShotOverride = z.object({
  /** 1-based raw line number */
  line: z.number().int().positive(),
  is_shot: z.boolean(),
});
export type ShotOverride = z.infer<typeof ShotOverride>;

export const ScriptInput = z.object({
  text: z.string().min(1).max(2_000_000),
  source_name: z.string().min(1),
  format: ScriptFormat,
  heading_overrides: z.array(HeadingOverride),
  shot_overrides: z.array(ShotOverride).default([]),
});
export type ScriptInput = z.infer<typeof ScriptInput>;

/** screenplay: scenes by headings; shot_list: one shot per line (or a 镜号/景别/画面 table), imported as shots */
export const ScriptKind = z.enum(['screenplay', 'shot_list']);
export type ScriptKind = z.infer<typeof ScriptKind>;

/** What a shot line says; null = not written (the import states its default). */
export const ShotLineInfo = z.object({
  /** the writer's own shot number */
  code: z.string().nullable(),
  shot_size: ShotSize.nullable(),
  angle: CameraAngle.nullable(),
  movement: Movement.nullable(),
  ots: z.boolean(),
  pov: z.boolean(),
  est_seconds: z.number().nullable(),
  dialogue: z.string().nullable(),
  action: z.string(),
  location: z.string().nullable(),
  time_label: z.string().nullable(),
  scene_key: z.string().nullable(),
});
export type ShotLineInfo = z.infer<typeof ShotLineInfo>;

export const ShotLinePreview = z.object({
  line: z.number().int().positive(),
  paragraph_id: ParagraphId,
  /** null: before any scene (not imported as a shot) */
  scene_idx: z.number().int().nonnegative().nullable(),
  info: ShotLineInfo,
});
export type ShotLinePreview = z.infer<typeof ShotLinePreview>;

export const ScriptPreview = ParsedScript.extend({
  /** 1-based line numbers the rules detected as scene headings */
  detected_heading_lines: z.array(z.number().int().positive()),
  /** 1-based line numbers the rules detected as shot lines */
  detected_shot_lines: z.array(z.number().int().positive()),
  kind: ScriptKind,
  shot_lines: z.array(ShotLinePreview),
});
export type ScriptPreview = z.infer<typeof ScriptPreview>;

export const ScriptImportResult = z.object({
  version: ScriptVersion,
  scenes: z.array(Scene),
  /** shots whose quote could not be re-found verbatim in the new version */
  needs_relink_shot_ids: z.array(Uuid),
  /** S2c: shots made from shot lines (lines already covered by a kept shot are skipped) */
  created_shot_ids: z.array(Uuid),
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
  /** S4: who imported it */
  actor: ActorRef.nullable().optional(),
});

export const UpdateSceneInput = z.object({
  screen_sides: ScreenSides.nullable().optional(),
  location_entity_id: Uuid.nullable().optional(),
});

export const CreateEntityInput = z.object({
  type: EntityType,
  name: z.string().min(1),
  aliases: z.array(z.string()),
  /** S3b: characters only; "" or null = none */
  actor_name: z.string().max(40).nullable().optional(),
});
export const UpdateEntityInput = z.object({
  name: z.string().min(1).optional(),
  aliases: z.array(z.string()).optional(),
  confirmed: z.boolean().optional(),
  /** S3b: characters only; "" or null clears it */
  actor_name: z.string().max(40).nullable().optional(),
  /** S4a: the revision the edit started from; a teammate's newer change makes this a 409 */
  expected_revision: z.number().int().nonnegative().optional(),
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
  /** 风格要求: free text from the user, handed to the model as data */
  reference_note: z.string().max(800).nullable(),
  max_shots: z.number().int().min(1).max(40),
  target_seconds: z.number().int().positive().nullable(),
  /** S3: a built-in or group style card */
  style_id: z.string().nullable().default(null),
  /** S3: how ambitious the shots may be */
  level: StyleLevel.default('steady'),
});
export type BreakdownRequest = z.infer<typeof BreakdownRequest>;

// ------------------------------------------------------------- S3a polish --

/** 细化 keeps the framing and adds detail; 优化 may change framing; 重写 redesigns the shot. */
export const PolishMode = z.enum(['refine', 'improve', 'rewrite']);
export type PolishMode = z.infer<typeof PolishMode>;

export const POLISH_MAX_SHOTS = 12;

export const PolishRequest = z.object({
  shot_ids: z.array(Uuid).min(1).max(POLISH_MAX_SHOTS),
  mode: PolishMode,
  instruction: z.string().trim().max(500).nullable(),
  style_id: z.string().nullable(),
  level: StyleLevel,
});
export type PolishRequest = z.infer<typeof PolishRequest>;

/** What the model may change: everything but the script source, which stays the shot's own. */
export const PolishedShotFields = ShotFields.omit({ source: true });
export type PolishedShotFields = z.infer<typeof PolishedShotFields>;

/** LLM output of a polish call: one item per input shot, by its ref (s1, s2 …). */
export const PolishOutput = z.object({
  shots: z.array(z.object({ ref: z.string(), change_note: z.string(), fields: PolishedShotFields })),
});
export type PolishOutput = z.infer<typeof PolishOutput>;

export const ApplyPolishInput = z.object({
  /** indices into draft.parsed.shots */
  selected: z.array(z.number().int().nonnegative()),
  expected_revisions: z.record(z.string(), z.number().int().nonnegative()),
});
export type ApplyPolishInput = z.infer<typeof ApplyPolishInput>;

export const ApplyPolishResult = z.object({
  updated: z.array(Shot),
  skipped_locked_ids: z.array(Uuid),
  skipped_missing_ids: z.array(Uuid),
});
export type ApplyPolishResult = z.infer<typeof ApplyPolishResult>;

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
export const UpdateResourceInput = CreateResourceInput.partial().extend({
  /** S4a: the revision the edit started from; a teammate's newer change makes this a 409 */
  expected_revision: z.number().int().nonnegative().optional(),
});

export const CreateSetupInput = z.object({
  location_resource_id: Uuid.nullable(),
  label: z.string().min(1),
  shot_ids: z.array(Uuid),
  resource_ids: z.array(Uuid),
  durations: SetupDurations,
  estimate_confirmed: z.boolean(),
});
export const UpdateSetupInput = CreateSetupInput.partial().extend({
  /** S4a: the revision the edit started from; a teammate's newer change makes this a 409 */
  expected_revision: z.number().int().nonnegative().optional(),
});

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

// ---- S1b: footage a browser reads on a team member's computer (hosted server) ----

export const CreateBrowserRootInput = z.object({ label: z.string().trim().min(1).max(80) });

export const BrowserFile = z.object({
  /** "/"-separated, relative to the opened project folder */
  rel_path: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  mtime_ms: z.number().nonnegative(),
});
export type BrowserFile = z.infer<typeof BrowserFile>;

/** The complete list of media files in the folder: anything not listed goes offline. */
export const BrowserFilesInput = z.object({ files: z.array(BrowserFile).max(20_000) });

export const BrowserAssetNeeds = z.object({
  asset_id: Uuid,
  rel_path: z.string(),
  size: z.number().int().nonnegative(),
  mtime_ms: z.number(),
  /** the server has no probe for this version of the file */
  probe: z.boolean(),
  poster: z.boolean(),
  hash: z.boolean(),
});
export type BrowserAssetNeeds = z.infer<typeof BrowserAssetNeeds>;

export const BrowserFilesOutput = z.object({
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  offline: z.number().int().nonnegative(),
  /** every listed file, with what the server still lacks */
  assets: z.array(BrowserAssetNeeds),
});
export type BrowserFilesOutput = z.infer<typeof BrowserFilesOutput>;

/**
 * Facts the browser read from one version of a file (size + mtime must still
 * match the server's row). The server derives kind/playable flags itself.
 */
export const AssetFactsInput = z.object({
  size: z.number().int().nonnegative(),
  mtime_ms: z.number(),
  /** null = the browser could not read this container (e.g. MXF) */
  probe: ProbeNormalized.nullable().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** the file changed while it was hashed, or hashing failed */
  hash_problem: z.enum(['source_changed', 'failed']).optional(),
});
export type AssetFactsInput = z.infer<typeof AssetFactsInput>;

/** Asset row for the library: asset + where it lives + review hints. */
export const MediaAssetView = MediaAsset.extend({
  root_label: z.string(),
  /** browser: the file is on a team member's computer; the web plays it from there (stream_url is null) */
  root_kind: SourceRootKind,
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


// ---------------------------------------------------------------- M4 -------
// Boards are laid out on the server (core layoutBoard) and rendered in the
// browser (core renderBoard). A board is stale when its basis_content_hash
// differs from the shot's current content_hash; the user chooses to
// regenerate (new layout, loses manual edits) or keep (re-baselines).

export const BoardView = Board.extend({
  stale: z.boolean(),
  shot_code: z.string(),
  scene_id: Uuid,
  /** adopted AI raster for this board version, if any (M8) */
  adopted_raster_id: Uuid.nullable(),
});
export type BoardView = z.infer<typeof BoardView>;

export const SaveBoardInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  spec: BoardSpec,
});
export const BoardRevisionInput = z.object({ expected_revision: z.number().int().nonnegative() });

// ---------------------------------------------------------------- M8 -------

export const SaveImageProviderInput = z.object({
  base_url: z.url(),
  model: z.string().min(1),
  api_key: z.string().nullable().optional(),
  dialect_override: ImageDialect.nullable(),
});

export const TestImageProviderInput = z.object({
  /** false: free checks only (GET /models); true: one smallest paid image after confirmation */
  paid: z.boolean(),
});

export const RedrawInput = z.object({
  /** the user saw the destination host, data sent and "cost per the provider's bill" */
  confirmed: z.boolean(),
  quality: z.enum(['low', 'medium', 'high']),
});

export const RasterView = BoardRaster.extend({
  /** same-origin URL of the post-processed raster PNG, null while pending/failed */
  image_url: z.string().nullable(),
  stale: z.boolean(),
});
export type RasterView = z.infer<typeof RasterView>;

// ---- S2a: accounts and groups (hosted server only; answered by the gateway) ----

/** Trimmed, lower-cased; the same address typed with other capitals is the same account. */
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, '邮箱格式不对');
export const Password = z.string().min(8, '密码至少 8 位').max(128);
export const DisplayName = z.string().trim().min(1).max(20);
export const EmailCode = z.string().trim().regex(/^\d{6}$/, '验证码是 6 位数字');

export const RegisterCodeInput = z.object({ email: Email, invite: z.string().trim().min(1).max(100) });
export const RegisterInput = z.object({ email: Email, code: EmailCode, name: DisplayName, password: Password });
export const PasswordLoginInput = z.object({ email: Email, password: z.string().min(1).max(128) });
export const EmailOnlyInput = z.object({ email: Email });
/** sign in with an emailed code; `new_password` also replaces the password (forgot password) */
export const CodeLoginInput = z.object({ email: Email, code: EmailCode, new_password: Password.optional() });
export const ChangePasswordInput = z.object({ current: z.string().min(1).max(128), next: Password });

export const GroupRole = z.enum(['leader', 'member']);
export type GroupRole = z.infer<typeof GroupRole>;
export const GroupMember = z.object({
  id: z.string(),
  name: z.string(),
  role: GroupRole,
  joined_at: z.string(),
  /** this member is the signed-in account */
  you: z.boolean(),
  /** S4: 导演、编剧、摄影… (set by the member or the leader) */
  crew_roles: z.array(z.string()).default([]),
});
export type GroupMember = z.infer<typeof GroupMember>;
export const GroupView = z.object({
  slug: z.string(),
  name: z.string(),
  /** what teammates type (or open as …/#join=<code>) to join */
  join_code: z.string(),
  role: GroupRole,
  members: z.array(GroupMember),
  max_members: z.number().int().positive(),
  /** S4: which model the signed-in account uses in this group */
  model_choice: z.object({ text: ModelSource, image: ModelSource }).default({ text: 'group', image: 'group' }),
});
export type GroupView = z.infer<typeof GroupView>;
export const AccountMe = z.object({
  email: z.string(),
  name: z.string(),
  /** the group this browser works in (its project is the one open) */
  group: GroupView.nullable(),
  /** S2d: every group of the account, earliest joined first */
  groups: z.array(GroupView),
  /** how many groups one account may be in at the same time */
  max_groups: z.number().int().positive(),
});
export type AccountMe = z.infer<typeof AccountMe>;

export const CreateGroupInput = z.object({ name: DisplayName });
/** S4 */
export const CrewRolesInput = z.object({ crew_roles: CrewRoles });
export const ModelChoiceInput = z.object({ text: ModelSource.optional(), image: ModelSource.optional() });
/** the code, or the whole …/#join=<code> link pasted */
export const JoinGroupInput = z.object({ code: z.string().trim().min(4).max(300) });
export const GroupPreview = z.object({
  slug: z.string(),
  name: z.string(),
  members: z.number().int().nonnegative(),
  full: z.boolean(),
  /** the asking account is already in it */
  joined: z.boolean(),
});
export type GroupPreview = z.infer<typeof GroupPreview>;
export const DisbandGroupInput = z.object({ confirm: z.literal(true) });


// -------------------------------------------------------------- registry ---

export const Api = {
  // M0
  session: { method: 'POST', path: '/api/v1/session', input: SessionInput },
  /** hosted server: sign out (drops this browser's session) */
  logout: { method: 'DELETE', path: '/api/v1/session' },
  site: { method: 'GET', path: '/api/v1/site', output: SiteInfo },
  health: { method: 'GET', path: '/api/v1/health', output: HealthInfo },
  // S2a — hosted accounts and groups
  registerCode: { method: 'POST', path: '/api/v1/account/register/code', input: RegisterCodeInput },
  register: { method: 'POST', path: '/api/v1/account/register', input: RegisterInput },
  passwordLogin: { method: 'POST', path: '/api/v1/account/login', input: PasswordLoginInput },
  loginCode: { method: 'POST', path: '/api/v1/account/login/code', input: EmailOnlyInput },
  codeLogin: { method: 'POST', path: '/api/v1/account/login/verify', input: CodeLoginInput },
  me: { method: 'GET', path: '/api/v1/account', output: AccountMe },
  changePassword: { method: 'POST', path: '/api/v1/account/password', input: ChangePasswordInput },
  createGroup: { method: 'POST', path: '/api/v1/groups', input: CreateGroupInput, output: GroupView },
  previewGroup: { method: 'POST', path: '/api/v1/groups/preview', input: JoinGroupInput, output: GroupPreview },
  joinGroup: { method: 'POST', path: '/api/v1/groups/join', input: JoinGroupInput, output: GroupView },
  /** S2d: work in another of one's groups (this browser only) */
  switchGroup: { method: 'POST', path: '/api/v1/groups/:slug/switch', output: GroupView },
  leaveGroup: { method: 'POST', path: '/api/v1/groups/:slug/leave' },
  resetGroupCode: { method: 'POST', path: '/api/v1/groups/:slug/code', output: GroupView },
  removeGroupMember: { method: 'DELETE', path: '/api/v1/groups/:slug/members/:id', output: GroupView },
  disbandGroup: { method: 'POST', path: '/api/v1/groups/:slug/disband', input: DisbandGroupInput },
  /** S4: a member's crew roles (the member or the leader) */
  setCrewRoles: { method: 'PUT', path: '/api/v1/groups/:slug/members/:id/crew-roles', input: CrewRolesInput, output: GroupView },
  /** S4: use the group's model or one's own, in this group */
  setModelChoice: { method: 'PUT', path: '/api/v1/groups/:slug/model-choice', input: ModelChoiceInput, output: GroupView },
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
  // S4 hosted: the signed-in account's own model (never visible to the group)
  getMyProviders: { method: 'GET', path: '/api/v1/settings/providers/me', output: ProvidersView },
  saveMyTextProvider: { method: 'PUT', path: '/api/v1/settings/providers/me/text', input: SaveTextProviderInput, output: ProvidersView },
  testMyTextProvider: { method: 'POST', path: '/api/v1/settings/providers/me/text/test', output: ProviderTestResult },

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

  // S4a — teammates' changes and who is online (query: since, epoch, tab, page, focus, hidden)
  collabChanges: { method: 'GET', path: '/api/v1/collab/changes', output: CollabChanges },

  // S4b — shot comments (hosted server)
  commentSummary: { method: 'GET', path: '/api/v1/comments/summary', output: CommentSummary },
  listComments: { method: 'GET', path: '/api/v1/shots/:id/comments', output: z.array(ShotComment) },
  createComment: { method: 'POST', path: '/api/v1/shots/:id/comments', input: CreateCommentInput, output: ShotComment },
  markCommentsRead: { method: 'POST', path: '/api/v1/shots/:id/comments/read' },
  updateComment: { method: 'PATCH', path: '/api/v1/comments/:id', input: UpdateCommentInput, output: ShotComment },
  deleteComment: { method: 'DELETE', path: '/api/v1/comments/:id', output: ShotComment },
  resolveComment: { method: 'POST', path: '/api/v1/comments/:id/resolve', output: ShotComment },
  reopenComment: { method: 'POST', path: '/api/v1/comments/:id/reopen', output: ShotComment },

  // S3 — style cards and research
  getStyles: { method: 'GET', path: '/api/v1/styles', output: StyleLibrary },
  createStyle: { method: 'POST', path: '/api/v1/styles', input: StyleCardInput, output: StyleCard },
  saveStyleDefaults: { method: 'PUT', path: '/api/v1/styles/defaults', input: StyleDefaults, output: StyleLibrary },
  researchStyle: { method: 'POST', path: '/api/v1/styles/research', input: StyleResearchInput, output: JobAccepted },
  updateStyle: { method: 'PUT', path: '/api/v1/styles/:id', input: StyleCardInput, output: StyleCard },
  deleteStyle: { method: 'DELETE', path: '/api/v1/styles/:id', output: z.object({ id: z.string() }) },
  saveResearchedStyle: { method: 'POST', path: '/api/v1/drafts/:id/save-style', input: StyleCardInput, output: StyleCard },
  // S3a — polish
  requestPolish: { method: 'POST', path: '/api/v1/shots/polish', input: PolishRequest, output: JobAccepted },
  applyPolish: { method: 'POST', path: '/api/v1/drafts/:id/apply-polish', input: ApplyPolishInput, output: ApplyPolishResult },
  // S3b — cast
  castSuggestions: { method: 'GET', path: '/api/v1/entities/cast', output: z.array(CastSuggestion) },
  applyCast: { method: 'POST', path: '/api/v1/entities/cast', input: CastApplyInput, output: z.array(Entity) },
  castSyncPreview: { method: 'GET', path: '/api/v1/resources/cast-sync', output: CastSyncPreview },
  applyCastSync: { method: 'POST', path: '/api/v1/resources/cast-sync', input: CastSyncApplyInput, output: z.array(Resource) },

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
  createBrowserRoot: { method: 'POST', path: '/api/v1/media/browser-roots', input: CreateBrowserRootInput, output: SourceRoot },
  reportBrowserFiles: { method: 'POST', path: '/api/v1/media/browser-roots/:id/files', input: BrowserFilesInput, output: BrowserFilesOutput },
  reportAssetFacts: { method: 'PUT', path: '/api/v1/media/assets/:id/facts', input: AssetFactsInput, output: MediaAssetView },
  listAssets: { method: 'GET', path: '/api/v1/media/assets', output: z.array(MediaAssetView) },
  searchAssets: { method: 'POST', path: '/api/v1/media/search', input: MediaSearchInput, output: z.array(MediaAssetView) },
  buildCandidates: { method: 'POST', path: '/api/v1/media/candidates', input: BuildCandidatesInput, output: BuildCandidatesOutput },
  listLinks: { method: 'GET', path: '/api/v1/links', output: z.array(ShotMediaLink) },
  createLink: { method: 'POST', path: '/api/v1/links', input: CreateLinkInput, output: ShotMediaLink },
  reviewLink: { method: 'PATCH', path: '/api/v1/links/:id', input: ReviewLinkInput, output: ShotMediaLink },
  coverage: { method: 'GET', path: '/api/v1/coverage', output: z.array(CoverageResult) },
  addCoverageDecision: { method: 'POST', path: '/api/v1/shots/:id/coverage-decisions', input: CoverageDecisionInput, output: CoverageDecision },
  // M4 — boards
  listBoards: { method: 'GET', path: '/api/v1/boards', output: z.array(BoardView) },
  shotBoardVersions: { method: 'GET', path: '/api/v1/shots/:id/boards', output: z.array(Board) },
  regenerateBoard: { method: 'POST', path: '/api/v1/shots/:id/boards', output: BoardView },
  saveBoard: { method: 'PATCH', path: '/api/v1/boards/:id', input: SaveBoardInput, output: BoardView },
  keepBoard: { method: 'POST', path: '/api/v1/boards/:id/keep', input: BoardRevisionInput, output: BoardView },

  // M8 — image provider & AI pencil redraw (experimental)
  saveImageProvider: { method: 'PUT', path: '/api/v1/settings/providers/image', input: SaveImageProviderInput, output: ProvidersView },
  testImageProvider: { method: 'POST', path: '/api/v1/settings/providers/image/test', input: TestImageProviderInput, output: ProviderTestResult },
  saveMyImageProvider: { method: 'PUT', path: '/api/v1/settings/providers/me/image', input: SaveImageProviderInput, output: ProvidersView },
  testMyImageProvider: { method: 'POST', path: '/api/v1/settings/providers/me/image/test', input: TestImageProviderInput, output: ProviderTestResult },
  requestRedraw: { method: 'POST', path: '/api/v1/boards/:id/redraw', input: RedrawInput, output: JobAccepted },
  listRasters: { method: 'GET', path: '/api/v1/boards/:id/rasters', output: z.array(RasterView) },
  adoptRaster: { method: 'POST', path: '/api/v1/rasters/:id/adopt', output: RasterView },
  rejectRaster: { method: 'POST', path: '/api/v1/rasters/:id/reject', output: RasterView },
} as const;
