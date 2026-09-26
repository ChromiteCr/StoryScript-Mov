import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiError, ErrorCode } from '@storyscript/contracts';

/** Default HTTP status per error code; AppError may override. */
const DEFAULT_STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  LOCKED_SHOT: 409,
  SOURCE_OFFLINE: 409,
  SOURCE_CHANGED: 409,
  PATH_NOT_ALLOWED: 403,
  MISSING_CONFIRMATION: 409,
  UNSUPPORTED_MEDIA: 415,
  UNSUPPORTED_TIMEBASE: 422,
  PROVIDER_NOT_CONFIGURED: 409,
  PROVIDER_ERROR: 502,
  PROVIDER_OUTCOME_UNKNOWN: 502,
  PROVIDER_REFUSED: 422,
  ATTEMPTS_EXHAUSTED: 502,
  FFMPEG_MISSING: 409,
  PROJECT_LOCKED: 409,
  QUOTA_EXCEEDED: 409,
  PROJECT_EXISTS: 409,
  NO_PROJECT_OPEN: 409,
  SCHEMA_VERSION_UNSUPPORTED: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, status?: ContentfulStatusCode, details?: unknown, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? DEFAULT_STATUS[code];
    this.details = details;
    this.retryable = retryable;
  }
}

export function isAppError(err: unknown, code?: ErrorCode): err is AppError {
  return err instanceof AppError && (code === undefined || err.code === code);
}

export function errorBody(code: ErrorCode, message: string, details?: unknown, retryable = false): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }), retryable } };
}

export function validationError(err: z.ZodError, message = '请求参数不合法'): AppError {
  const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));
  return new AppError('VALIDATION_ERROR', message, 400, { issues });
}

/** Hono onError: every failure leaves as the contracts ApiError envelope. */
export function onError(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(errorBody(err.code, err.message, err.details, err.retryable), err.status);
  }
  if (err instanceof z.ZodError) {
    const e = validationError(err);
    return c.json(errorBody(e.code, e.message, e.details), 400);
  }
  if (err instanceof HTTPException) {
    const status = err.status;
    const code: ErrorCode = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL';
    return c.json(errorBody(code, err.message || '请求无法处理'), status);
  }
  console.error('[storyscript-mov] unhandled error:', err);
  return c.json(errorBody('INTERNAL', '服务器内部错误', undefined, true), 500);
}
