import { z } from 'zod';
import { ActorRef, IsoTime, Uuid } from './common.ts';

// ---------------------------------------------------------------------------
// S4a — teammates' changes show up without reloading, and who is online.
// Each group instance keeps an in-memory feed: a sequence number per area
// and the last few events. Browsers poll it; an area that moved means those
// queries refetch. The poll itself is the presence heartbeat.
// ---------------------------------------------------------------------------

export const CollabArea = z.enum([
  'script',
  'shots',
  'boards',
  'plan',
  'takes',
  'media',
  'entities',
  'styles',
  'drafts',
  'jobs',
  'project',
  'comments',
  'members',
  'settings',
]);
export type CollabArea = z.infer<typeof CollabArea>;

export const CollabVerb = z.enum(['changed', 'created', 'archived', 'imported', 'applied', 'approved', 'logged', 'saved', 'finished', 'commented']);
export type CollabVerb = z.infer<typeof CollabVerb>;

/** The pages a browser can be on (for 「阿杰 · 分镜页」). */
export const CollabPage = z.enum(['home', 'projects', 'script', 'boards', 'plan', 'set', 'media', 'deliver', 'settings', 'other']);
export type CollabPage = z.infer<typeof CollabPage>;

export const CollabEvent = z.object({
  seq: z.number().int().positive(),
  at: IsoTime,
  /** null: the local app, or a job that outlived its requester */
  actor: ActorRef.nullable(),
  areas: z.array(CollabArea),
  verb: CollabVerb,
  /** where it happened, when known: 「第 3 场」「3-002」 */
  scene_no: z.string().nullable(),
  shot_code: z.string().nullable(),
  /** the write came from the tab that is polling (it already refreshed what it changed) */
  from_this_tab: z.boolean().default(false),
});
export type CollabEvent = z.infer<typeof CollabEvent>;

export const PresenceEntry = z.object({
  actor: ActorRef,
  page: CollabPage,
  /** the shot open in their editor, if any */
  focus_shot_id: Uuid.nullable(),
  /** their tab is in the background */
  away: z.boolean(),
  you: z.boolean(),
  at: IsoTime,
});
export type PresenceEntry = z.infer<typeof PresenceEntry>;

export const CollabChangesQuery = z.object({
  /** the last seq this browser applied (0 on the first poll) */
  since: z.coerce.number().int().nonnegative().default(0),
  /** the feed's epoch this browser knows ('' on the first poll) */
  epoch: z.string().max(64).default(''),
  /** one id per browser tab */
  tab: z.string().max(64).default(''),
  page: CollabPage.catch('other').default('other'),
  focus: Uuid.optional().catch(undefined),
  hidden: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});

export const CollabChanges = z.object({
  /** random per server start: a different one means refetch everything */
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  /** last seq of every area that ever changed */
  area_seq: z.record(z.string(), z.number().int().nonnegative()),
  /** events after `since` (at most the last 50) */
  events: z.array(CollabEvent),
  /** `since` is older than what the feed still remembers, or the epoch changed: refetch everything */
  reset: z.boolean(),
  presence: z.array(PresenceEntry),
  /** changes when a member joins, leaves, renames or changes crew roles */
  members_rev: z.string(),
});
export type CollabChanges = z.infer<typeof CollabChanges>;
