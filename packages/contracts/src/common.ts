import { z } from 'zod';

export const CONTRACTS_VERSION = '1.0.0';

export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** UTC ISO-8601 timestamp, e.g. 2026-09-26T08:00:00.000Z */
export const IsoTime = z.iso.datetime({ offset: false });
export type IsoTime = z.infer<typeof IsoTime>;

export const Origin = z.enum(['ai', 'manual']);

// ---------------------------------------------------------------------------
// S4 — who did it. On the hosted server every history row records the
// account that made it; the API returns the name and crew roles as they are
// now (`left`: no longer in the group). Local single-user rows have no actor.
// Never carries an email.
// ---------------------------------------------------------------------------

export const CREW_ROLE_PRESETS = ['导演', '编剧', '制片', '摄影', '美术', '录音', '剪辑', '场记', '灯光', '演员'] as const;
export const CREW_ROLES_MAX = 6;
export const CrewRole = z
  .string()
  .trim()
  .min(1)
  .max(8)
  .regex(/^[^\s@,，、]+$/, '职务里不能有空格、@ 或逗号');
export const CrewRoles = z.array(CrewRole).max(CREW_ROLES_MAX);
export type CrewRoles = z.infer<typeof CrewRoles>;

export const ActorRef = z.object({
  id: z.string(),
  name: z.string(),
  crew_roles: z.array(z.string()),
  /** no longer in the group */
  left: z.boolean(),
});
export type ActorRef = z.infer<typeof ActorRef>;

/** Whose model a request used: the group's (set by the leader) or the member's own. */
export const ModelSource = z.enum(['group', 'own']);
export type ModelSource = z.infer<typeof ModelSource>;
export type Origin = z.infer<typeof Origin>;

export const ErrorCode = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'LOCKED_SHOT',
  'SOURCE_OFFLINE',
  'SOURCE_CHANGED',
  'PATH_NOT_ALLOWED',
  'MISSING_CONFIRMATION',
  'UNSUPPORTED_MEDIA',
  'UNSUPPORTED_TIMEBASE',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_ERROR',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_REFUSED',
  'ATTEMPTS_EXHAUSTED',
  /** project-level soft cap on paid generations reached */
  'QUOTA_EXCEEDED',
  'FFMPEG_MISSING',
  'PROJECT_LOCKED',
  'PROJECT_EXISTS',
  'NO_PROJECT_OPEN',
  'SCHEMA_VERSION_UNSUPPORTED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  /** hosted server: too many wrong attempts or emails from this address or account; retry later */
  'TOO_MANY_ATTEMPTS',
  /** hosted server: this email already has an account */
  'ACCOUNT_EXISTS',
  /** hosted server: signed in, but not in a group yet (create or join one) */
  'NO_TEAM',
  /** hosted server: the verification email could not be sent */
  'MAIL_FAILED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
    retryable: z.boolean(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Wraps a data schema in the success envelope `{ data }`. */
export const ok = <T extends z.ZodType>(data: T) => z.object({ data });

export const JobAccepted = z.object({ job_id: Uuid });
export type JobAccepted = z.infer<typeof JobAccepted>;
