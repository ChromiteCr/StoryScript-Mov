import { z } from 'zod';
import { ActorRef, IsoTime, ModelSource, Uuid } from './common.ts';

export const JobStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'outcome_unknown',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobKind = z.enum([
  'extract_entities',
  'breakdown_scene',
  'suggest_order',
  'scan_root',
  'probe_asset',
  'hash_asset',
  'poster_asset',
  'image_redraw',
  'research_style',
  'polish_shots',
  'check_script',
]);
export type JobKind = z.infer<typeof JobKind>;

export const Job = z.object({
  id: Uuid,
  kind: JobKind,
  idempotency_key: z.string(),
  /** true for jobs that call paid remote services (never auto-resent) */
  remote: z.boolean(),
  status: JobStatus,
  attempts: z.number().int().nonnegative(),
  input_hash: z.string(),
  progress: z.number().min(0).max(1).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  usage: z.record(z.string(), z.number()).nullable(),
  result_ref: z.string().nullable(),
  created_at: IsoTime,
  updated_at: IsoTime,
  /** S4: who started it, and whose model it used */
  actor: ActorRef.nullable().optional(),
  model_source: ModelSource.nullable().optional(),
});
export type Job = z.infer<typeof Job>;
