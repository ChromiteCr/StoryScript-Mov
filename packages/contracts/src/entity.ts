import { z } from 'zod';
import { Origin, Uuid } from './common.ts';

export const EntityType = z.enum(['character', 'location', 'prop']);
export type EntityType = z.infer<typeof EntityType>;

/** Short alias handed to the LLM instead of UUIDs: c1, c2 (characters), l1 (locations), o1 (props). */
export const EntityAlias = z.string().regex(/^[clo]\d{1,3}$/);
export type EntityAlias = z.infer<typeof EntityAlias>;

export const Entity = z.object({
  id: Uuid,
  type: EntityType,
  alias: EntityAlias,
  name: z.string().min(1),
  aliases: z.array(z.string()),
  origin: Origin,
  confirmed: z.boolean(),
  /** S3b: characters only — who plays the part (shown in the plan and call sheets, never sent to a model) */
  actor_name: z.string().max(40).nullable(),
  /** S4a: bumped by every change; updates may name the one they started from */
  revision: z.number().int().nonnegative().optional(),
});
export type Entity = z.infer<typeof Entity>;

/** LLM output for entity extraction. Flat, all fields required (provider-portable schema). */
export const EntitiesOutput = z.object({
  characters: z.array(z.object({ name: z.string(), aliases: z.array(z.string()) })),
  locations: z.array(z.object({ name: z.string(), aliases: z.array(z.string()) })),
  props: z.array(z.object({ name: z.string(), aliases: z.array(z.string()) })),
});
export type EntitiesOutput = z.infer<typeof EntitiesOutput>;
