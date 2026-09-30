import { z } from 'zod';
import { ActorRef, IsoTime, Uuid } from './common.ts';

export const CoverageStatus = z.enum(['planned', 'attempted', 'usable', 'needs_pickup', 'waived']);
export type CoverageStatus = z.infer<typeof CoverageStatus>;

export const CoverageDecisionKind = z.enum(['usable', 'needs_pickup', 'clear']);
export type CoverageDecisionKind = z.infer<typeof CoverageDecisionKind>;

/** Append-only human decision (SPEC §5.9). Waive/restore live on Shot.required_status. */
export const CoverageDecision = z.object({
  id: Uuid,
  shot_id: Uuid,
  decision: CoverageDecisionKind,
  selected_link_ids: z.array(Uuid),
  reason: z.string().min(1),
  basis_content_hash: z.string(),
  at: IsoTime,
  /** S4: who decided */
  actor: ActorRef.nullable().optional(),
});
export type CoverageDecision = z.infer<typeof CoverageDecision>;

export const MissingReason = z.enum(['no_take', 'no_link', 'no_confirmed_usable', 'file_offline']);
export type MissingReason = z.infer<typeof MissingReason>;

export const CoverageFlag = z.enum(['previously_usable', 'source_offline', 'decision_stale']);
export type CoverageFlag = z.infer<typeof CoverageFlag>;

/** Output of core/coverage.computeCoverage — never stored. */
export const CoverageResult = z.object({
  shot_id: Uuid,
  status: CoverageStatus,
  required_status: z.enum(['required', 'optional', 'waived']),
  facts: z.object({
    take_count: z.number().int().nonnegative(),
    link_count: z.number().int().nonnegative(),
    confirmed_link_count: z.number().int().nonnegative(),
    offline_link_count: z.number().int().nonnegative(),
  }),
  flags: z.array(CoverageFlag),
  /** set only for required shots that are not usable/waived */
  missing_reason: MissingReason.nullable(),
});
export type CoverageResult = z.infer<typeof CoverageResult>;
