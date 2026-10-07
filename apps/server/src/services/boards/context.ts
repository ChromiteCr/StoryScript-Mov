import { Technique, type FrameFormat, type Shot } from '@storyscript/contracts';
import { cyrb53, isContinuityTime, LOOK_WIDE_PENCIL, TECHNIQUES, type LayoutContext, type RosterEntry } from '@storyscript/core';
import type { DbPort } from '../../db/port.ts';
import { listEntities } from '../../db/repos/entity.ts';
import { getProject } from '../../db/repos/project.ts';
import { getScene, listScenes } from '../../db/repos/script.ts';

/**
 * Everything core/board layoutBoard needs besides the shot fields, read from
 * the project database. Pure data in, so the same shot + project state always
 * lays out the same board.
 *
 * - roster: character entities in alias order (c1, c2 …, i.e. the order they
 *   were extracted / created ≈ order of appearance). label = name, badge = A, B,
 *   C … by that order, so a character wears the same badge on every board.
 * - scene_sides: the scene's 180° axis (who holds screen-left / right).
 * - look: the single built-in look "宽银幕铅笔分镜".
 * - technique: builtin card or user card referenced by shot.fields.technique_id.
 * - aspect: shot.fields.frame_format ?? project.default_aspect.
 * - seed: stable hash of the shot id (same shot → same pencil jitter forever).
 * - time_label (S5b): the scene heading's time (日 / 夜 / 黄昏): the frame's light;
 *   a "same as before" label (CONTINUOUS, 稍后) takes the nearest earlier scene's.
 * - prop_names (S5b): the project's prop entities (names and aliases): an
 *   insert's object is named by the one its action mentions.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function badgeFor(index: number): string {
  return LETTERS[index] ?? String(index + 1);
}

export function characterRosterEntries(db: DbPort): RosterEntry[] {
  return listEntities(db)
    .filter((e) => e.type === 'character')
    .map((e, i) => ({ alias: e.alias, label: e.name, badge: badgeFor(i), entity_id: e.id, aliases: e.aliases }));
}

interface TechniqueRow {
  id: string;
  version: number;
  name: string;
  intended_effect: string;
  shot_grammar: string;
  camera_defaults_json: string;
  applicable_scenes: string;
  resource_cost_notes: string;
  low_budget_alternative: string;
  sources_json: string;
  limitations: string;
  builtin: number;
}

/** Builtin technique card, else a user card from the technique table (null when unknown or unreadable). */
export function techniqueById(db: DbPort, id: string | null): Technique | null {
  if (!id) return null;
  const builtin = TECHNIQUES.find((t) => t.id === id);
  if (builtin) return builtin;
  const r = db.get<TechniqueRow>(
    `SELECT id, version, name, intended_effect, shot_grammar, camera_defaults_json, applicable_scenes,
            resource_cost_notes, low_budget_alternative, sources_json, limitations, builtin
       FROM technique WHERE id = ?`,
    id,
  );
  if (!r) return null;
  try {
    const parsed = Technique.safeParse({
      ...r,
      camera_defaults: JSON.parse(r.camera_defaults_json),
      sources: JSON.parse(r.sources_json),
      builtin: r.builtin === 1,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Positive 31-bit seed from the shot's UUID. */
export function shotSeed(shotId: string): number {
  return cyrb53(shotId) % 2147483647;
}

export interface ProjectBoardContext {
  roster: RosterEntry[];
  defaultAspect: FrameFormat;
  /** S5b: prop entity names and aliases */
  propNames: string[];
  /** memoised per call site: scene id → screen sides */
  sides(sceneId: string): LayoutContext['scene_sides'];
  /** S5b: scene id → its heading's time label */
  timeLabel(sceneId: string): string | null;
  technique(id: string | null): Technique | null;
}

/** Read the project-wide inputs once (list endpoints lay out many shots). */
export function projectBoardContext(db: DbPort): ProjectBoardContext {
  const roster = characterRosterEntries(db);
  const defaultAspect = getProject(db)?.default_aspect ?? '2.39';
  const propNames = listEntities(db)
    .filter((e) => e.type === 'prop')
    .flatMap((e) => [e.name, ...e.aliases]);
  const sceneCache = new Map<string, ReturnType<typeof getScene>>();
  const scene = (id: string) => {
    if (!sceneCache.has(id)) sceneCache.set(id, getScene(db, id));
    return sceneCache.get(id) ?? null;
  };
  const techCache = new Map<string, Technique | null>();
  return {
    roster,
    defaultAspect,
    propNames,
    sides(sceneId) {
      return scene(sceneId)?.screen_sides ?? null;
    },
    timeLabel(sceneId) {
      const sc = scene(sceneId);
      const own = sc?.time_label ?? null;
      if (!sc || !isContinuityTime(own)) return own;
      // CONTINUOUS / 稍后: the time of the nearest scene before it that says one
      const list = listScenes(db, sc.script_version_id);
      for (let i = list.findIndex((s) => s.id === sc.id) - 1; i >= 0; i--) {
        const t = list[i]!.time_label;
        if (t && !isContinuityTime(t)) return t;
      }
      return null;
    },
    technique(id) {
      if (!id) return null;
      if (!techCache.has(id)) techCache.set(id, techniqueById(db, id));
      return techCache.get(id) ?? null;
    },
  };
}

export function layoutContextFor(shot: Shot, pc: ProjectBoardContext): LayoutContext {
  return {
    scene_sides: pc.sides(shot.scene_id),
    roster: pc.roster,
    look: LOOK_WIDE_PENCIL,
    technique: pc.technique(shot.fields.technique_id),
    aspect: shot.fields.frame_format ?? pc.defaultAspect,
    seed: shotSeed(shot.id),
    time_label: pc.timeLabel(shot.scene_id),
    prop_names: pc.propNames,
  };
}
