import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { CameraAngle, CreateSetupInput, DeriveSetupsInput, Facing, Setup, Shot, UpdateSetupInput } from '@storyscript/contracts';
import { ZH_CAMERA_ANGLE, ZH_FACING } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { getResource, listResources } from '../../db/repos/resource.ts';
import { getScene, type SceneRecord } from '../../db/repos/script.ts';
import {
  deleteSetupRow,
  getSetup,
  listSetups,
  markSetupEdited,
  readAutoSetups,
  saveSetup,
  writeAutoSetups,
  type AutoSetups,
} from '../../db/repos/setup.ts';
import { getShot, listActiveShots } from '../../db/repos/shot.ts';
import { AppError } from '../../http/errors.ts';

/**
 * Setups (FR-06). Manual CRUD plus `derive`, which groups every active
 * (non-archived, non-waived) shot by location resource + camera bucket
 * (fields.angle + the first subject's facing, null → camera).
 *
 * The location resource of a shot is the location resource whose
 * cast_character_ids contains its scene's location_entity_id. Shots without
 * one are grouped by the scene's location entity, or else by scene, so
 * unrelated places never share a setup just because neither is cast yet.
 */

type Input<S extends z.ZodType> = z.infer<S>;

export function requireSetup(db: DbPort, id: string): Setup {
  const s = getSetup(db, id);
  if (!s) throw new AppError('NOT_FOUND', 'setup 不存在', 404);
  return s;
}

function checkLocation(db: DbPort, id: string | null): void {
  if (id === null) return;
  const r = getResource(db, id);
  if (!r) throw new AppError('VALIDATION_ERROR', '场地资源不存在', 400, { resource_id: id });
  if (r.type !== 'location') throw new AppError('VALIDATION_ERROR', `「${r.name}」不是场地资源`, 400, { resource_id: id });
}

function cleanResources(db: DbPort, ids: readonly string[], location: string | null): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (id === location || out.includes(id)) continue;
    if (!getResource(db, id)) throw new AppError('VALIDATION_ERROR', '资源不存在', 400, { resource_id: id });
    out.push(id);
  }
  return out;
}

function cleanShots(db: DbPort, ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (out.includes(id)) continue;
    const shot = getShot(db, id);
    if (!shot) throw new AppError('VALIDATION_ERROR', '镜头不存在', 400, { shot_id: id });
    if (shot.archived) throw new AppError('VALIDATION_ERROR', `镜头 ${shot.code} 已归档，不能加入 setup`, 400, { shot_id: id });
    out.push(id);
  }
  return out;
}

function cleanLabel(label: string): string {
  const t = label.trim();
  if (!t) throw new AppError('VALIDATION_ERROR', 'setup 名称不能为空', 400);
  return t;
}

export function createSetup(db: DbPort, input: Input<typeof CreateSetupInput>): Setup {
  return db.tx(() => {
    checkLocation(db, input.location_resource_id);
    const setup: Setup = {
      id: randomUUID(),
      location_resource_id: input.location_resource_id,
      label: cleanLabel(input.label),
      shot_ids: cleanShots(db, input.shot_ids),
      resource_ids: cleanResources(db, input.resource_ids, input.location_resource_id),
      durations: input.durations,
      estimate_confirmed: input.estimate_confirmed,
    };
    saveSetup(db, setup);
    return setup;
  });
}

export function updateSetup(db: DbPort, id: string, input: Input<typeof UpdateSetupInput>): Setup {
  return db.tx(() => {
    const cur = requireSetup(db, id);
    const location = input.location_resource_id !== undefined ? input.location_resource_id : cur.location_resource_id;
    checkLocation(db, location);
    const next: Setup = {
      id,
      location_resource_id: location,
      label: input.label !== undefined ? cleanLabel(input.label) : cur.label,
      shot_ids: input.shot_ids !== undefined ? cleanShots(db, input.shot_ids) : cur.shot_ids,
      resource_ids: cleanResources(db, input.resource_ids ?? cur.resource_ids, location),
      durations: input.durations ?? cur.durations,
      estimate_confirmed: input.estimate_confirmed ?? cur.estimate_confirmed,
    };
    saveSetup(db, next);
    markSetupEdited(db, id);
    return getSetup(db, id)!;
  });
}

export function deleteSetup(db: DbPort, id: string): { id: string } {
  return db.tx(() => {
    requireSetup(db, id);
    deleteSetupRow(db, id);
    return { id };
  });
}

// ----------------------------------------------------------------- derive ---

interface Group {
  key: string;
  location: string | null;
  angle: CameraAngle;
  facing: Facing;
  scenes: string[];
  shots: string[];
}

/** Camera bucket of a shot: angle + first subject's facing (null → camera). */
export function cameraBucket(shot: Pick<Shot, 'fields'>): { angle: CameraAngle; facing: Facing } {
  return { angle: shot.fields.angle, facing: shot.fields.subjects[0]?.facing ?? 'camera' };
}

export function setupLabel(sceneNos: readonly string[], angle: CameraAngle, facing: Facing): string {
  return `场${sceneNos.join('/')} · ${ZH_CAMERA_ANGLE[angle]} · ${ZH_FACING[facing]}`;
}

export function deriveSetups(db: DbPort, input: Input<typeof DeriveSetupsInput>, now = new Date().toISOString()): Setup[] {
  return db.tx(() => {
    const auto = readAutoSetups(db);
    const existing = listSetups(db);
    // kept: user-created (never derived) or edited since derive
    const kept = input.keep_edited ? existing.filter((s) => !auto[s.id] || auto[s.id]!.edited) : [];
    const keptIds = new Set(kept.map((s) => s.id));
    const keptShots = new Set(kept.flatMap((s) => s.shot_ids));

    // a regenerated group keeps the id of the setup derived for the same key (constraints survive)
    const reusable = new Map<string, string>();
    for (const s of existing) {
      const m = auto[s.id];
      if (!keptIds.has(s.id) && m && !reusable.has(m.key)) reusable.set(m.key, s.id);
    }

    const locationResources = listResources(db).filter((r) => r.type === 'location');
    const sceneCache = new Map<string, SceneRecord | null>();
    const sceneOf = (id: string) => {
      if (!sceneCache.has(id)) sceneCache.set(id, getScene(db, id));
      return sceneCache.get(id)!;
    };

    const groups = new Map<string, Group>();
    for (const shot of listActiveShots(db)) {
      if (shot.required_status === 'waived' || keptShots.has(shot.id)) continue;
      const scene = sceneOf(shot.scene_id);
      const entityId = scene?.location_entity_id ?? null;
      const locRes = entityId ? (locationResources.find((r) => r.cast_character_ids.includes(entityId)) ?? null) : null;
      const place = locRes ? `res:${locRes.id}` : entityId ? `ent:${entityId}` : `scene:${shot.scene_id}`;
      const { angle, facing } = cameraBucket(shot);
      const key = `${place}|${angle}|${facing}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, location: locRes?.id ?? null, angle, facing, scenes: [], shots: [] };
        groups.set(key, g);
      }
      const no = scene?.display_no ?? '?';
      if (!g.scenes.includes(no)) g.scenes.push(no);
      g.shots.push(shot.id);
    }

    const reused = new Set<string>();
    const plan = [...groups.values()].map((g) => {
      const id = reusable.get(g.key) ?? randomUUID();
      reused.add(id);
      return { g, id };
    });
    for (const s of existing) if (!keptIds.has(s.id) && !reused.has(s.id)) deleteSetupRow(db, s.id);

    const labels = new Set(kept.map((s) => s.label));
    const nextAuto: AutoSetups = {};
    for (const s of kept) if (auto[s.id]) nextAuto[s.id] = auto[s.id]!;
    for (const { g, id } of plan) {
      const base = setupLabel(g.scenes, g.angle, g.facing);
      let label = base;
      for (let n = 2; labels.has(label); n++) label = `${base} #${n}`;
      labels.add(label);
      saveSetup(db, {
        id,
        location_resource_id: g.location,
        label,
        shot_ids: g.shots,
        resource_ids: [],
        durations: input.default_durations,
        estimate_confirmed: false,
      });
      nextAuto[id] = { key: g.key, edited: false };
    }
    writeAutoSetups(db, nextAuto, now);
    return listSetups(db);
  });
}
