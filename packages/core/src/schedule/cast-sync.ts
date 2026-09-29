import type { CastSyncChange, Resource } from '@storyscript/contracts';
import { splitActorNames } from '../script/cast.ts';
import { contentHash } from '../util/hash.ts';

/**
 * S3b: what the plan's resources need to match the script's cast and
 * locations. Performers are matched by name (spaces collapsed); a character
 * the script gives to someone else moves from the performer who had it.
 * Characters without an actor, and locations already covered, stay as they
 * are. The plan never removes a performer or a location here.
 */

export interface CastSyncInput {
  characters: readonly { id: string; name: string; actor_name: string | null }[];
  locations: readonly { id: string; name: string }[];
  resources: readonly Resource[];
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

export function planCastSync(input: CastSyncInput): CastSyncChange[] {
  const changes: CastSyncChange[] = [];
  const performers = input.resources.filter((r) => r.type === 'performer');
  const byName = new Map(performers.map((r) => [norm(r.name), r] as const));

  for (const c of input.characters) {
    if (!c.actor_name) continue;
    const actors = splitActorNames(c.actor_name);
    // "/" or "、" alone names nobody: treat as no actor
    if (actors.length === 0) continue;
    const wanted = new Set(actors.map(norm));
    // performers the script no longer gives this character to
    const owners = performers.filter((r) => r.cast_character_ids.includes(c.id) && !wanted.has(norm(r.name)));
    for (const actor of actors) {
      const res = byName.get(norm(actor)) ?? null;
      if (res?.cast_character_ids.includes(c.id)) continue;
      const base = { resource_id: res?.id ?? null, resource_name: res?.name ?? actor, entity_id: c.id, entity_name: c.name };
      const from = owners.shift();
      if (from) changes.push({ kind: 'move_cast', ...base, from_resource_id: from.id, from_resource_name: from.name });
      else changes.push({ kind: res ? 'add_cast' : 'create_performer', ...base, from_resource_id: null, from_resource_name: null });
    }
    // more old owners than new actors: the rest simply lose the character
    for (const from of owners) {
      const target = byName.get(norm(actors[0]!));
      changes.push({
        kind: 'move_cast',
        resource_id: target?.id ?? null,
        resource_name: target?.name ?? actors[0]!,
        entity_id: c.id,
        entity_name: c.name,
        from_resource_id: from.id,
        from_resource_name: from.name,
      });
    }
  }

  const places = input.resources.filter((r) => r.type === 'location');
  const covered = new Set(places.flatMap((r) => r.cast_character_ids));
  const placeByName = new Map(places.map((r) => [norm(r.name), r] as const));
  for (const l of input.locations) {
    if (covered.has(l.id)) continue;
    const res = placeByName.get(norm(l.name)) ?? null;
    changes.push({
      kind: res ? 'add_cast' : 'create_location',
      resource_id: res?.id ?? null,
      resource_name: res?.name ?? l.name,
      entity_id: l.id,
      entity_name: l.name,
      from_resource_id: null,
      from_resource_name: null,
    });
  }
  return changes;
}

/** Stale-apply guard: the same script and plan give the same hash. */
export function castSyncHash(changes: readonly CastSyncChange[]): string {
  return contentHash(changes);
}
