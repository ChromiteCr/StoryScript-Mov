import { z } from 'zod';
import { ActorRef, IsoTime } from './common.ts';
import { JobKind } from './job.ts';

/**
 * S5 用量看板: what the project's paid model calls used, from the job rows
 * (remote jobs only; --demo replays nothing billable). On the hosted server
 * the group's key and the member's own key are reported apart; a member's
 * own usage is shown to that member only.
 */

/** Whose key: the local app's one setting, the group's, or the member's own. */
export const UsageSource = z.enum(['local', 'group', 'own']);
export type UsageSource = z.infer<typeof UsageSource>;

export const UsageTotals = z.object({
  jobs: z.number().int().nonnegative(),
  /** outbound requests (job attempts) */
  requests: z.number().int().nonnegative(),
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative(),
  /** requests whose response carried no usage */
  unknown_calls: z.number().int().nonnegative(),
  /** jobs whose paid request left but whose result is unknown */
  outcome_unknown: z.number().int().nonnegative(),
  /** images returned by the image model */
  images: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageCurrency = z.enum(['CNY', 'USD']);
export type UsageCurrency = z.infer<typeof UsageCurrency>;

const PriceNumber = z.number().min(0).max(10000).nullable();

/** Unit prices for the estimate (the provider's bill is what counts). */
export const UsagePrice = z.object({
  currency: UsageCurrency,
  /** per million prompt tokens */
  input_per_m: PriceNumber,
  /** per million completion tokens */
  output_per_m: PriceNumber,
  per_image: PriceNumber,
});
export type UsagePrice = z.infer<typeof UsagePrice>;

export const EMPTY_USAGE_PRICE: UsagePrice = { currency: 'CNY', input_per_m: null, output_per_m: null, per_image: null };

export const UsageDay = z.object({
  /** local date in the project's time zone, YYYY-MM-DD */
  date: z.string(),
  requests: z.number().int().nonnegative(),
  total_tokens: z.number().nonnegative(),
  images: z.number().int().nonnegative(),
});
export type UsageDay = z.infer<typeof UsageDay>;

export const UsageSourceReport = z.object({
  source: UsageSource,
  today: UsageTotals,
  total: UsageTotals,
  by_kind: z.array(z.object({ kind: JobKind, totals: UsageTotals })),
  /** group key only: who spent it */
  by_member: z.array(z.object({ actor: ActorRef.nullable(), totals: UsageTotals })).nullable(),
  /** the last 14 local days, oldest first */
  days: z.array(UsageDay),
  price: UsagePrice,
  can_edit_price: z.boolean(),
});
export type UsageSourceReport = z.infer<typeof UsageSourceReport>;

export const QuotaLane = z.object({
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export type QuotaLane = z.infer<typeof QuotaLane>;

/** GET /api/v1/usage */
export const UsageReport = z.object({
  timezone: z.string(),
  /** today's local date in the project's time zone */
  today: z.string(),
  generated_at: IsoTime,
  sources: z.array(UsageSourceReport),
  /** hosted: the group key's rolling 24-hour caps */
  caps: z.object({ llm: QuotaLane, image: QuotaLane }).nullable(),
  /** --demo: recordings are replayed, nothing is sent or billed */
  demo: z.boolean(),
});
export type UsageReport = z.infer<typeof UsageReport>;

export const SaveUsagePriceInput = z.object({ source: UsageSource, price: UsagePrice });
export type SaveUsagePriceInput = z.infer<typeof SaveUsagePriceInput>;
