import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError, validationError } from './errors.ts';

/** Parse the JSON body with a contracts schema; failures become 400 VALIDATION_ERROR. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('VALIDATION_ERROR', '请求体不是有效的 JSON', 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}
