import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { CreateResourceInput, Resource, ResourceType, TimeWindow, UpdateResourceInput } from '@storyscript/contracts';
import type { DbPort } from '../../db/port.ts';
import { getEntity } from '../../db/repos/entity.ts';
import { deleteResourceRow, getResource, insertResource, updateResourceRow } from '../../db/repos/resource.ts';
import { setupsUsingResource } from '../../db/repos/setup.ts';
import { AppError } from '../../http/errors.ts';
import { assertExpectedRevision } from '../revision.ts';

/**
 * Resources (FR-06): performers (cast to character entities), locations
 * (mapped to location entities, scene.location_entity_id) and equipment.
 * Windows are UTC half-open intervals; the web converts local HH:mm with
 * core localWindowToUtc before sending.
 */

type Input<S extends z.ZodType> = z.infer<S>;

const CAST_ENTITY_TYPE: Record<ResourceType, 'character' | 'location' | null> = {
  performer: 'character',
  location: 'location',
  equipment: null,
};

export function requireResource(db: DbPort, id: string): Resource {
  const r = getResource(db, id);
  if (!r) throw new AppError('NOT_FOUND', '资源不存在', 404);
  return r;
}

export function cleanWindows(windows: readonly TimeWindow[]): TimeWindow[] {
  const out: TimeWindow[] = [];
  windows.forEach((w, i) => {
    const start = Date.parse(w.start_utc);
    const end = Date.parse(w.end_utc);
    if (!(start < end)) {
      throw new AppError('VALIDATION_ERROR', `第 ${i + 1} 个可用时间段的结束时间必须晚于开始时间`, 400, { index: i, window: w });
    }
    if (!out.some((o) => o.start_utc === w.start_utc && o.end_utc === w.end_utc)) out.push({ start_utc: w.start_utc, end_utc: w.end_utc });
  });
  return out.sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
}

function cleanCast(db: DbPort, type: ResourceType, ids: readonly string[]): string[] {
  const want = CAST_ENTITY_TYPE[type];
  const unique = [...new Set(ids)];
  if (want === null) {
    if (unique.length > 0) throw new AppError('VALIDATION_ERROR', '设备不能关联角色或地点', 400);
    return [];
  }
  for (const id of unique) {
    const e = getEntity(db, id);
    if (!e) throw new AppError('VALIDATION_ERROR', '关联的实体不存在', 400, { entity_id: id });
    if (e.type !== want) {
      throw new AppError(
        'VALIDATION_ERROR',
        want === 'character' ? `演员只能关联角色，「${e.name}」不是角色` : `场地只能关联地点，「${e.name}」不是地点`,
        400,
        { entity_id: id },
      );
    }
  }
  return unique;
}

function cleanName(name: string): string {
  const t = name.trim();
  if (!t) throw new AppError('VALIDATION_ERROR', '名称不能为空', 400);
  return t;
}

export function createResource(db: DbPort, input: Input<typeof CreateResourceInput>): Resource {
  return db.tx(() => {
    const res: Resource = {
      id: randomUUID(),
      type: input.type,
      name: cleanName(input.name),
      windows: cleanWindows(input.windows),
      cast_character_ids: cleanCast(db, input.type, input.cast_character_ids),
      confirmed: input.confirmed,
    };
    insertResource(db, res);
    return { ...res, revision: 0 };
  });
}

export function updateResource(db: DbPort, id: string, input: Input<typeof UpdateResourceInput>): Resource {
  return db.tx(() => {
    const cur = requireResource(db, id);
    assertExpectedRevision(`资源「${cur.name}」`, cur.revision, input.expected_revision);
    const type = input.type ?? cur.type;
    if (type !== cur.type) {
      const used = setupsUsingResource(db, id);
      if (used.length > 0) {
        throw new AppError('VALIDATION_ERROR', `资源正被 ${used.length} 个 setup 使用，不能改类型`, 409, {
          setups: used.map((s) => ({ id: s.id, label: s.label })),
        });
      }
    }
    const next: Resource = {
      id,
      type,
      name: input.name !== undefined ? cleanName(input.name) : cur.name,
      windows: input.windows !== undefined ? cleanWindows(input.windows) : cur.windows,
      // a type change re-checks the existing casting against the new type
      cast_character_ids: cleanCast(db, type, input.cast_character_ids ?? (type === cur.type ? cur.cast_character_ids : [])),
      confirmed: input.confirmed ?? cur.confirmed,
    };
    updateResourceRow(db, next);
    return requireResource(db, id);
  });
}

/** 409 with the referencing setups when a setup still uses the resource. */
export function deleteResource(db: DbPort, id: string): { id: string } {
  return db.tx(() => {
    const cur = requireResource(db, id);
    const used = setupsUsingResource(db, id);
    if (used.length > 0) {
      throw new AppError('VALIDATION_ERROR', `「${cur.name}」正被 ${used.length} 个 setup 使用，先从这些 setup 中移除它`, 409, {
        setups: used.map((s) => ({ id: s.id, label: s.label })),
      });
    }
    deleteResourceRow(db, id);
    return { id };
  });
}
