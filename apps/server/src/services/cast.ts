import { randomUUID } from 'node:crypto';
import type { CastApplyInput, CastSuggestion, CastSyncApplyInput, CastSyncPreview, Entity, Resource } from '@storyscript/contracts';
import { castSyncHash, planCastSync, readCastList } from '@storyscript/core';
import type { DbPort } from '../db/port.ts';
import { cleanAliases, getEntity, insertEntity, listEntities, nextAlias, updateEntityRow } from '../db/repos/entity.ts';
import { getResource, insertResource, listResources, updateResourceRow } from '../db/repos/resource.ts';
import { latestScriptVersion, listScenes } from '../db/repos/script.ts';
import { AppError } from '../http/errors.ts';
import { cleanActorName } from './entities.ts';
import { cleanWindows } from './plan/resources.ts';

/**
 * S3b: who plays whom. The script's cast list fills in the characters'
 * actors (the user ticks what to take); the plan's performer and location
 * resources are then synced from the script, so nobody types the cast twice.
 */

/** Paragraph texts of the current script before its first scene (where a cast list sits). */
function preSceneTexts(db: DbPort): string[] {
  const version = latestScriptVersion(db);
  if (!version) return [];
  const scenes = listScenes(db, version.id);
  const first = scenes[0]?.paragraph_ids[0];
  const at = first ? version.paragraphs.findIndex((p) => p.id === first) : -1;
  return (at >= 0 ? version.paragraphs.slice(0, at) : version.paragraphs).map((p) => p.text);
}

export function castSuggestions(db: DbPort): CastSuggestion[] {
  const characters = listEntities(db).filter((e) => e.type === 'character');
  return readCastList(preSceneTexts(db), characters);
}

/** Apply ticked cast-list lines: set actors, split an alias into its own character, or create one. */
export function applyCast(db: DbPort, input: CastApplyInput): Entity[] {
  return db.tx(() => {
    const out = new Map<string, Entity>();
    const create = (name: string, actor: string): Entity => {
      const existing = listEntities(db).find((e) => e.type === 'character' && e.name === name);
      if (existing) {
        const next = { ...existing, actor_name: cleanActorName('character', actor) };
        updateEntityRow(db, next);
        return next;
      }
      const e: Entity = {
        id: randomUUID(),
        type: 'character',
        alias: nextAlias(db, 'character'),
        name,
        aliases: [],
        origin: 'manual',
        confirmed: true,
        actor_name: cleanActorName('character', actor),
      };
      insertEntity(db, e);
      return e;
    };
    for (const item of input.items) {
      if (item.entity_id === null) {
        if (!item.new_character_name) throw new AppError('VALIDATION_ERROR', '没有对应角色的行需要填写新角色的名字', 400, { item });
        const e = create(item.new_character_name, item.actor_name);
        out.set(e.id, e);
        continue;
      }
      const entity = getEntity(db, item.entity_id);
      if (!entity || entity.type !== 'character') throw new AppError('NOT_FOUND', '角色不存在，可能已被删除', 404, { item });
      if (item.split_alias) {
        const alias = item.split_alias.trim();
        if (!entity.aliases.includes(alias)) throw new AppError('VALIDATION_ERROR', `「${entity.name}」没有别名「${alias}」`, 400, { item });
        const trimmed = { ...entity, aliases: cleanAliases(entity.aliases.filter((a) => a !== alias), entity.name) };
        updateEntityRow(db, trimmed);
        out.set(trimmed.id, trimmed);
        const e = create(alias, item.actor_name);
        out.set(e.id, e);
        continue;
      }
      const next = { ...(out.get(entity.id) ?? entity), actor_name: cleanActorName('character', item.actor_name) };
      updateEntityRow(db, next);
      out.set(next.id, next);
    }
    return [...out.values()];
  });
}

function syncInput(db: DbPort) {
  const entities = listEntities(db);
  return {
    characters: entities.filter((e) => e.type === 'character'),
    locations: entities.filter((e) => e.type === 'location'),
    resources: listResources(db),
  };
}

export function castSyncPreview(db: DbPort): CastSyncPreview {
  const changes = planCastSync(syncInput(db));
  return { changes, hash: castSyncHash(changes) };
}

/** Apply the whole preview (locations optional); new resources get the given windows and confirmation. */
export function applyCastSync(db: DbPort, input: CastSyncApplyInput): Resource[] {
  return db.tx(() => {
    const changes = planCastSync(syncInput(db));
    if (castSyncHash(changes) !== input.hash) {
      throw new AppError('VALIDATION_ERROR', '剧本或计划刚被修改过，请重新打开同步看最新的变化', 409);
    }
    const windows = cleanWindows(input.windows);
    const touched = new Map<string, Resource>();
    const created = new Map<string, Resource>();
    const load = (id: string): Resource => {
      const r = touched.get(id) ?? getResource(db, id);
      if (!r) throw new AppError('NOT_FOUND', '资源不存在，可能已被删除', 404, { resource_id: id });
      return r;
    };
    const target = (c: (typeof changes)[number], type: Resource['type']): Resource => {
      if (c.resource_id) return load(c.resource_id);
      const key = `${type}:${c.resource_name}`;
      let r = created.get(key);
      if (!r) {
        r = { id: randomUUID(), type, name: c.resource_name, windows, cast_character_ids: [], confirmed: input.confirmed };
        insertResource(db, r);
        created.set(key, r);
      }
      return r;
    };
    for (const c of changes) {
      const isPlace = c.kind === 'create_location' || (c.kind === 'add_cast' && getEntity(db, c.entity_id)?.type === 'location');
      if (isPlace && !input.include_locations) continue;
      const r = target(c, isPlace ? 'location' : 'performer');
      if (!r.cast_character_ids.includes(c.entity_id)) r.cast_character_ids = [...r.cast_character_ids, c.entity_id];
      touched.set(r.id, r);
      if (c.kind === 'move_cast' && c.from_resource_id) {
        const from = load(c.from_resource_id);
        from.cast_character_ids = from.cast_character_ids.filter((id) => id !== c.entity_id);
        touched.set(from.id, from);
      }
    }
    for (const r of touched.values()) updateResourceRow(db, r);
    return [...touched.values()];
  });
}
