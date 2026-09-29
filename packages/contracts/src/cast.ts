import { z } from 'zod';
import { Uuid } from './common.ts';
import { TimeWindow } from './plan.ts';

// ---------------------------------------------------------------------------
// S3b — who plays whom. The script's characters carry the actor's name
// (Entity.actor_name); the cast list at the top of a script fills it in, and
// the plan's performer and location resources are synced from it.
// ---------------------------------------------------------------------------

export const ACTOR_NAME_MAX = 40;

/** How a cast-list line was matched to a character. */
export const CastMatch = z.enum(['exact', 'alias', 'near', 'none']);
export type CastMatch = z.infer<typeof CastMatch>;

export const CastSuggestion = z.object({
  /** the cast-list line as written */
  line: z.string(),
  actor_name: z.string(),
  /** the character as the cast list names it */
  character_label: z.string(),
  entity_id: Uuid.nullable(),
  entity_name: z.string().nullable(),
  match: CastMatch,
  /** the label is an alias of `entity_id` played by someone else: split it into its own character */
  split_alias: z.string().nullable(),
  /** the character already has exactly this actor */
  current: z.boolean(),
});
export type CastSuggestion = z.infer<typeof CastSuggestion>;

export const CastApplyInput = z.object({
  items: z.array(
    z.object({
      entity_id: Uuid.nullable(),
      actor_name: z.string().trim().min(1).max(ACTOR_NAME_MAX),
      split_alias: z.string().trim().min(1).nullable(),
      /** entity_id null: create this character */
      new_character_name: z.string().trim().min(1).max(40).nullable(),
    }),
  ),
});
export type CastApplyInput = z.infer<typeof CastApplyInput>;

export const CastSyncKind = z.enum(['create_performer', 'add_cast', 'move_cast', 'create_location']);
export type CastSyncKind = z.infer<typeof CastSyncKind>;

/** One change the plan needs to match the script's cast and locations. */
export const CastSyncChange = z.object({
  kind: CastSyncKind,
  /** the performer/location resource changed; null when it will be created */
  resource_id: Uuid.nullable(),
  /** actor name, or location name */
  resource_name: z.string(),
  /** character (performers) or location entity */
  entity_id: Uuid,
  entity_name: z.string(),
  /** move_cast: the performer who played the character until now */
  from_resource_id: Uuid.nullable(),
  from_resource_name: z.string().nullable(),
});
export type CastSyncChange = z.infer<typeof CastSyncChange>;

export const CastSyncPreview = z.object({
  changes: z.array(CastSyncChange),
  /** stale-apply guard: the hash of `changes` */
  hash: z.string(),
});
export type CastSyncPreview = z.infer<typeof CastSyncPreview>;

export const CastSyncApplyInput = z.object({
  hash: z.string(),
  include_locations: z.boolean(),
  /** availability of newly created performers and locations (an empty list means never available) */
  windows: z.array(TimeWindow).default([]),
  /** the user checked that the new people and places are available then */
  confirmed: z.boolean().default(false),
});
export type CastSyncApplyInput = z.infer<typeof CastSyncApplyInput>;
