import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  EntitiesOutput,
  type CreateEntityInput,
  type Entity,
  type EntityDraftSelection,
  type EntityType,
  type UpdateEntityInput,
} from '@storyscript/contracts';
import type { DbPort } from '../db/port.ts';
import { getDraft, setDraftStatus } from '../db/repos/draft.ts';
import { cleanAliases, findEntityByName, getEntity, insertEntity, nextAlias, updateEntityRow } from '../db/repos/entity.ts';
import { AppError } from '../http/errors.ts';

type Input<S extends z.ZodType> = z.infer<S>;

const KIND_TYPE: Record<'characters' | 'locations' | 'props', EntityType> = {
  characters: 'character',
  locations: 'location',
  props: 'prop',
};

export function createEntity(db: DbPort, input: Input<typeof CreateEntityInput>): Entity {
  return db.tx(() => {
    const name = input.name.trim();
    if (!name) throw new AppError('VALIDATION_ERROR', '名称不能为空', 400);
    const e: Entity = {
      id: randomUUID(),
      type: input.type,
      alias: nextAlias(db, input.type),
      name,
      aliases: cleanAliases(input.aliases, name),
      origin: 'manual',
      confirmed: true,
    };
    insertEntity(db, e);
    return e;
  });
}

export function updateEntity(db: DbPort, id: string, input: Input<typeof UpdateEntityInput>): Entity {
  return db.tx(() => {
    const e = getEntity(db, id);
    if (!e) throw new AppError('NOT_FOUND', '实体不存在', 404);
    const name = input.name !== undefined ? input.name.trim() : e.name;
    if (!name) throw new AppError('VALIDATION_ERROR', '名称不能为空', 400);
    const next: Entity = {
      ...e,
      name,
      aliases: cleanAliases(input.aliases ?? e.aliases, name),
      confirmed: input.confirmed ?? e.confirmed,
    };
    updateEntityRow(db, next);
    return next;
  });
}

/**
 * Apply an entity-extraction draft with the user's edits. Entities with the
 * same type and name are merged (aliases united) instead of duplicated; new
 * ones are origin=ai, confirmed=false.
 */
export function applyEntityDraft(db: DbPort, draftId: string, input: Input<typeof EntityDraftSelection>): Entity[] {
  return db.tx(() => {
    const draft = getDraft(db, draftId);
    if (!draft || draft.kind !== 'entities') throw new AppError('NOT_FOUND', '实体草案不存在', 404);
    if (draft.status !== 'pending') throw new AppError('VALIDATION_ERROR', `草案状态为 ${draft.status}，不能应用`, 409);
    const parsed = EntitiesOutput.safeParse(draft.parsed);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '草案没有可应用的内容', 409);
    const out = new Map<string, Entity>();
    for (const item of input.items) {
      if (!parsed.data[item.kind][item.index]) {
        throw new AppError('VALIDATION_ERROR', `草案中没有 ${item.kind}[${item.index}]`, 400, { item });
      }
      const type = KIND_TYPE[item.kind];
      const name = item.name.trim();
      if (!name) throw new AppError('VALIDATION_ERROR', '名称不能为空', 400, { item });
      const existing = findEntityByName(db, type, name);
      if (existing) {
        const merged: Entity = { ...existing, aliases: cleanAliases([...existing.aliases, ...item.aliases], existing.name) };
        updateEntityRow(db, merged);
        out.set(merged.id, merged);
      } else {
        const e: Entity = {
          id: randomUUID(),
          type,
          alias: nextAlias(db, type),
          name,
          aliases: cleanAliases(item.aliases, name),
          origin: 'ai',
          confirmed: false,
        };
        insertEntity(db, e);
        out.set(e.id, e);
      }
    }
    setDraftStatus(db, draft.id, 'applied');
    return [...out.values()];
  });
}
