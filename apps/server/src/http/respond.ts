import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { AppError } from './errors.ts';

/**
 * `{ data }` success envelope, validated against the contracts output schema.
 * A mismatch is a server bug (500), never silently sent to the client.
 */
export function respond<S extends z.ZodType>(c: Context, schema: S, data: z.input<S>, status: ContentfulStatusCode = 200, extra?: Record<string, unknown>) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AppError('INTERNAL', '响应数据不符合接口契约', 500, {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return c.json({ data: parsed.data, ...extra }, status);
}

/** Path parameter that must be a UUID-looking id; anything else is a 404. */
export function idParam(c: Context, name = 'id'): string {
  const v = c.req.param(name);
  if (!v || !/^[0-9a-f-]{36}$/i.test(v)) throw new AppError('NOT_FOUND', '对象不存在', 404);
  return v;
}
