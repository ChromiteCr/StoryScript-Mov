import { z } from 'zod';

/** Text model: OpenAI chat-completions compatible endpoint (BYOK). */
export const TextProviderConfig = z.object({
  base_url: z.url(),
  model: z.string().min(1),
});
export type TextProviderConfig = z.infer<typeof TextProviderConfig>;

export const ImageDialect = z.enum(['openai-edits', 'generations-ref']);
export type ImageDialect = z.infer<typeof ImageDialect>;

export const ImageProviderConfig = z.object({
  base_url: z.url(),
  model: z.string().min(1),
  /** null = auto-detect from host */
  dialect_override: ImageDialect.nullable(),
});
export type ImageProviderConfig = z.infer<typeof ImageProviderConfig>;

/** JSON preset describing a generations-ref dialect (community-extendable). */
export const ImagePreset = z.object({
  id: z.string(),
  name: z.string(),
  host_patterns: z.array(z.string()),
  dialect: z.literal('generations-ref'),
  /** path appended to base_url, e.g. /images/generations */
  path: z.string(),
  /** body field receiving reference images, e.g. "image" or "input_references" */
  ref_field: z.string(),
  ref_format: z.enum(['data_url', 'b64']),
  ref_is_array: z.boolean(),
  size_mode: z.enum(['pixels', 'aspect_enum']),
  size_field: z.string(),
  aspect_values: z.array(z.string()),
  /** dot path to the base64 image (or url) in the response */
  response_path: z.string(),
  response_kind: z.enum(['b64', 'url']),
  extra_body: z.record(z.string(), z.unknown()),
  /** params that may be stripped and retried once on HTTP 400 */
  optional_params: z.array(z.string()),
  verified: z.boolean(),
  verified_at: z.string().nullable(),
  notes: z.string(),
});
export type ImagePreset = z.infer<typeof ImagePreset>;

/** Capability ladder for structured output, cached per base_url+model. */
export const StructuredMode = z.enum(['json_schema', 'json_object', 'prompt_only']);
export type StructuredMode = z.infer<typeof StructuredMode>;

export const Usage = z.object({
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  total_tokens: z.number().nullable(),
});
export type Usage = z.infer<typeof Usage>;
