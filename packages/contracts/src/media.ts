import { z } from 'zod';
import { IsoTime, Uuid } from './common.ts';

export const MAX_SAFE_PTS = Number.MAX_SAFE_INTEGER;

const SafeInt = z.number().int().min(-MAX_SAFE_PTS).max(MAX_SAFE_PTS);

/**
 * Frozen source_range structure (SPEC §8.3). Half-open [in_pts, out_pts) on a
 * specific stream, rational time base. No float seconds, no frame numbers.
 * Stream/time-base consistency with the referenced asset is checked by
 * core/media.validateSourceRange.
 */
export const SourceRange = z
  .object({
    stream_index: z.number().int().nonnegative(),
    in_pts: SafeInt,
    out_pts: SafeInt,
    time_base_num: z.number().int().positive(),
    time_base_den: z.number().int().positive(),
  })
  .refine((r) => r.out_pts > r.in_pts, { message: 'out_pts must be greater than in_pts' });
export type SourceRange = z.infer<typeof SourceRange>;

export const StreamInfo = z.object({
  index: z.number().int().nonnegative(),
  codec_type: z.enum(['video', 'audio', 'data', 'subtitle', 'attachment', 'unknown']),
  codec_name: z.string().nullable(),
  profile: z.string().nullable(),
  pix_fmt: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  time_base_num: z.number().int().positive(),
  time_base_den: z.number().int().positive(),
  start_pts: SafeInt.nullable(),
  duration_ts: SafeInt.nullable(),
  r_frame_rate: z.string().nullable(),
  avg_frame_rate: z.string().nullable(),
  bits_per_raw_sample: z.number().int().nullable(),
});
export type StreamInfo = z.infer<typeof StreamInfo>;

export const ProbeNormalized = z.object({
  format_name: z.string(),
  duration_s: z.number().nullable(),
  streams: z.array(StreamInfo),
  timecode: z.string().nullable(),
  creation_time: z.string().nullable(),
});
export type ProbeNormalized = z.infer<typeof ProbeNormalized>;

/**
 * fs: an absolute folder the local server reads; project: the project folder
 * itself (paths relative to it); browser: a folder only a team member's
 * browser reads (hosted server) — the server never sees its files.
 */
export const SourceRootKind = z.enum(['fs', 'project', 'browser']);
export type SourceRootKind = z.infer<typeof SourceRootKind>;

export const SourceRoot = z.object({
  id: Uuid,
  kind: SourceRootKind,
  /** fs: realpath of the user-granted directory; project/browser: an opaque key, not a path */
  abs_path: z.string(),
  label: z.string(),
  created_at: IsoTime,
});
export type SourceRoot = z.infer<typeof SourceRoot>;

export const MediaKind = z.enum(['video', 'audio', 'image', 'other']);
export type MediaKind = z.infer<typeof MediaKind>;
export const HashStatus = z.enum(['pending', 'done', 'source_changed', 'failed', 'skipped']);
export type HashStatus = z.infer<typeof HashStatus>;
export const Availability = z.enum(['online', 'offline']);
export type Availability = z.infer<typeof Availability>;

export const MediaAsset = z.object({
  id: Uuid,
  source_root_id: Uuid,
  rel_path: z.string(),
  size: z.number().int().nonnegative(),
  mtime_ms: z.number(),
  kind: MediaKind,
  probe: ProbeNormalized.nullable(),
  video_stream_index: z.number().int().nullable(),
  playable_direct: z.boolean(),
  is_vfr_suspect: z.boolean(),
  has_timecode: z.boolean(),
  sha256: z.string().nullable(),
  hash_status: HashStatus,
  poster_path: z.string().nullable(),
  availability: Availability,
  created_at: IsoTime,
});
export type MediaAsset = z.infer<typeof MediaAsset>;

export const LinkEvidence = z.enum(['R1', 'R2', 'R3', 'manual']);
export type LinkEvidence = z.infer<typeof LinkEvidence>;

export const LinkStatus = z.enum(['candidate', 'confirmed', 'rejected']);
export type LinkStatus = z.infer<typeof LinkStatus>;

export const ShotMediaLink = z.object({
  id: Uuid,
  shot_id: Uuid,
  media_asset_id: Uuid,
  take_id: Uuid.nullable(),
  source_range: SourceRange,
  evidence: LinkEvidence,
  status: LinkStatus,
  confirmed_at: IsoTime.nullable(),
  revision: z.number().int().nonnegative(),
  created_at: IsoTime,
});
export type ShotMediaLink = z.infer<typeof ShotMediaLink>;

/** Candidate produced by core/media rules before it becomes a ShotMediaLink. */
export const LinkCandidate = z.object({
  shot_id: Uuid,
  media_asset_id: Uuid,
  take_id: Uuid.nullable(),
  evidence: z.enum(['R1', 'R2', 'R3']),
  detail: z.string(),
  conflict: z.boolean(),
});
export type LinkCandidate = z.infer<typeof LinkCandidate>;

// ---- S1b/S1c: records a browser keeps inside an opened project folder ----
// <project folder>/.storyscript-mov/ holds them; footage files are never touched.

export const FOLDER_RECORDS_DIR = '.storyscript-mov';

/** link.json — which site and project this folder's footage belongs to. */
export const FolderLink = z.object({
  format: z.literal('storyscript-mov-folder'),
  version: z.literal(1),
  /** origin of the hosted site, e.g. https://story.example.com */
  site: z.string(),
  project_id: Uuid,
  /** the server's browser root for this folder */
  root_id: Uuid,
  label: z.string(),
  created_at: IsoTime,
});
export type FolderLink = z.infer<typeof FolderLink>;

/** What the browser already learned about one version (size + mtime) of a file. */
export const MediaIndexEntry = z.object({
  size: z.number().int().nonnegative(),
  mtime_ms: z.number(),
  /** null with probe_failed = the browser cannot read this container */
  probe: ProbeNormalized.nullable(),
  probe_failed: z.boolean(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export type MediaIndexEntry = z.infer<typeof MediaIndexEntry>;

/** media-index.json — lets a reopen (or a teammate's copy) skip unchanged files. */
export const MediaIndex = z.object({
  format: z.literal('storyscript-mov-media-index'),
  version: z.literal(1),
  /** keyed by rel_path ("/"-separated, relative to the project folder) */
  files: z.record(z.string(), MediaIndexEntry),
});
export type MediaIndex = z.infer<typeof MediaIndex>;
