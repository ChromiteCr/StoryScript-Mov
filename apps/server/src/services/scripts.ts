import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Scene, ScriptImportResult, ScriptInput, ScriptVersion } from '@storyscript/contracts';
import { contentHash, normalizeForMatch, parseScript, relinkShots, shotFieldsFromLine } from '@storyscript/core';
import type { DbPort } from '../db/port.ts';
import { listEntities } from '../db/repos/entity.ts';
import { insertScene, insertScriptVersion, latestScriptVersion, listScenes, getScene, stripSort, type SceneRecord } from '../db/repos/script.ts';
import { listActiveShots, updateShotRow } from '../db/repos/shot.ts';
import { createShot } from './shots.ts';

/**
 * Import = new immutable script_version + its scenes, and carry the existing
 * shots over (SPEC FR-02):
 *   - a shot whose quote is found verbatim in the new text keeps its anchor
 *     (script_version_id / paragraph_id updated) and moves to the scene that
 *     now holds that paragraph;
 *   - otherwise needs_relink = true, anchor untouched (suggestion only).
 * Old scenes map to new ones by heading (k-th occurrence ↔ k-th occurrence);
 * user settings on a mapped scene (screen sides, location) are carried over.
 * Everything happens in one transaction.
 */

const headingKey = (h: string) => normalizeForMatch(h);

/** old scene id → new scene id, matching equal headings by occurrence order. */
function mapScenes(oldScenes: readonly SceneRecord[], newScenes: readonly Scene[]): Map<string, string> {
  const byHeading = new Map<string, string[]>();
  for (const s of newScenes) {
    const k = headingKey(s.heading);
    byHeading.set(k, [...(byHeading.get(k) ?? []), s.id]);
  }
  const map = new Map<string, string>();
  const byVersion = new Map<string, SceneRecord[]>();
  for (const s of oldScenes) byVersion.set(s.script_version_id, [...(byVersion.get(s.script_version_id) ?? []), s]);
  for (const scenes of byVersion.values()) {
    const seen = new Map<string, number>();
    for (const s of [...scenes].sort((a, b) => a.sort - b.sort)) {
      const k = headingKey(s.heading);
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      const target = byHeading.get(k)?.[n];
      if (target) map.set(s.id, target);
    }
  }
  return map;
}

/** `shot_overrides` may be left out (callers other than the API: demo seed, tests). */
export function importScript(db: DbPort, input: z.input<typeof ScriptInput>, now = new Date().toISOString()): ScriptImportResult {
  const parsed = parseScript(input.text, input.format, input.heading_overrides, {
    shotOverrides: input.shot_overrides ?? [],
    untitledScene: input.source_name,
  });
  return db.tx(() => {
    const previous = latestScriptVersion(db);
    const version: ScriptVersion = {
      id: randomUUID(),
      parent_id: previous?.id ?? null,
      source_name: input.source_name,
      format: input.format,
      content_hash: contentHash(input.text),
      raw_text: input.text,
      paragraphs: parsed.paragraphs,
      created_at: now,
    };
    insertScriptVersion(db, version);

    const prevScenes = previous ? listScenes(db, previous.id) : [];
    const locations = listEntities(db).filter((e) => e.type === 'location');
    const scenes: Scene[] = parsed.scenes.map((s) => ({
      id: randomUUID(),
      script_version_id: version.id,
      display_no: s.display_no,
      heading: s.heading,
      paragraph_ids: s.paragraph_ids,
      location_entity_id: null,
      time_label: s.time_label,
      screen_sides: null,
      origin: 'manual',
    }));
    // carry settings of mapped scenes of the previous version; else auto-link a location by name
    const prevMap = mapScenes(prevScenes, scenes);
    const reverse = new Map([...prevMap].map(([o, n]) => [n, o]));
    scenes.forEach((scene, i) => {
      const old = reverse.get(scene.id);
      const oldScene = old ? prevScenes.find((p) => p.id === old) : undefined;
      if (oldScene) {
        scene.location_entity_id = oldScene.location_entity_id;
        scene.screen_sides = oldScene.screen_sides;
      } else {
        const label = parsed.scenes[i]!.location_label?.trim();
        const hit = label ? locations.find((l) => l.name === label || l.aliases.includes(label)) : undefined;
        scene.location_entity_id = hit?.id ?? null;
      }
      insertScene(db, scene, i);
    });

    // carry shots over
    const shots = listActiveShots(db);
    const oldSceneIds = [...new Set(shots.map((s) => s.scene_id))];
    const oldScenes = oldSceneIds.map((id) => getScene(db, id)).filter((s): s is SceneRecord => s !== null);
    const sceneMap = mapScenes(oldScenes, scenes);
    const paragraphScene = new Map<string, string>();
    scenes.forEach((s) => s.paragraph_ids.forEach((p) => paragraphScene.set(p, s.id)));
    const relink = relinkShots(
      shots.map((s) => ({ id: s.id, source_anchor: s.source_anchor })),
      parsed.paragraphs.map((p) => ({ id: p.id, text: p.text })),
    );
    const kept = new Map(relink.kept.map((k) => [k.shot_id, k.paragraph_id]));
    const flagged = new Set(relink.needs_relink);
    for (const shot of shots) {
      const pid = kept.get(shot.id);
      if (pid && shot.source_anchor) {
        updateShotRow(db, {
          ...shot,
          scene_id: paragraphScene.get(pid) ?? sceneMap.get(shot.scene_id) ?? shot.scene_id,
          source_anchor: {
            ...shot.source_anchor,
            script_version_id: version.id,
            paragraph_id: pid,
            match: shot.source_anchor.match === 'manual' ? 'manual' : 'exact',
          },
          needs_relink: false,
          updated_at: now,
        });
      } else {
        updateShotRow(db, {
          ...shot,
          scene_id: sceneMap.get(shot.scene_id) ?? shot.scene_id,
          needs_relink: flagged.has(shot.id) ? true : shot.needs_relink,
          updated_at: now,
        });
      }
    }

    // S2c: a shot line becomes a manual shot anchored to its own paragraph, unless a kept shot already sits there
    const anchored = new Set(kept.values());
    const created: string[] = [];
    const byParagraph = new Map(parsed.paragraphs.map((p) => [p.id, p.text]));
    for (const line of parsed.shot_lines) {
      if (line.scene_idx === null || anchored.has(line.paragraph_id)) continue;
      const quote = byParagraph.get(line.paragraph_id) ?? '';
      const code = line.info.code ? `（原镜号 ${line.info.code}）` : '';
      const shot = createShot(
        db,
        {
          scene_id: scenes[line.scene_idx]!.id,
          fields: shotFieldsFromLine(line.info, { paragraph_id: line.paragraph_id, quote }),
          manual_note: `来自分镜脚本第 ${line.line} 行${code}`,
        },
        now,
      );
      created.push(shot.id);
    }

    return {
      version,
      scenes: listScenes(db, version.id).map(stripSort),
      needs_relink_shot_ids: relink.needs_relink,
      created_shot_ids: created,
    };
  });
}
