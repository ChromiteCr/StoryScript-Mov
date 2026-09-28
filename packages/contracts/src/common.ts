import { z } from 'zod';

export const CONTRACTS_VERSION = '1.0.0';

export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** UTC ISO-8601 timestamp, e.g. 2026-09-26T08:00:00.000Z */
export const IsoTime = z.iso.datetime({ offset: false });
export type IsoTime = z.infer<typeof IsoTime>;

export const Origin = z.enum(['ai', 'manual']);
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
