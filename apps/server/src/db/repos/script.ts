import type { z } from 'zod';
import { Paragraph, Scene, ScreenSides, ScriptVersion, type ScriptVersionSummary } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** script_version / scene ↔ contracts. Versions are immutable once inserted. */

interface VersionRow {
  id: string;
  parent_id: string | null;
  source_name: string;
  format: string;
  content_hash: string;
  raw_text: string;
  paragraphs_json: string;
  created_at: string;
}

interface SceneRow {
  id: string;
  script_version_id: string;
  sort: number;
  display_no: string;
  heading: string;
  paragraph_ids_json: string;
  location_entity_id: string | null;
  time_label: string | null;
  screen_sides_json: string | null;
  origin: string;
}

export type SceneRecord = Scene & { sort: number };
export type VersionSummary = z.infer<typeof ScriptVersionSummary>;

const V_COLS = 'id, parent_id, source_name, format, content_hash, raw_text, paragraphs_json, created_at';
const S_COLS =
  'id, script_version_id, sort, display_no, heading, paragraph_ids_json, location_entity_id, time_label, screen_sides_json, origin';

function versionFromRow(r: VersionRow): ScriptVersion {
  return ScriptVersion.parse({ ...r, paragraphs: JSON.parse(r.paragraphs_json) });
}

function sceneFromRow(r: SceneRow): SceneRecord {
  const scene = Scene.parse({
    ...r,
    paragraph_ids: JSON.parse(r.paragraph_ids_json),
    screen_sides: r.screen_sides_json === null ? null : ScreenSides.parse(JSON.parse(r.screen_sides_json)),
  });
  return { ...scene, sort: r.sort };
}

export function insertScriptVersion(db: DbPort, v: ScriptVersion): void {
  const x = ScriptVersion.parse(v);
  db.run(
    `INSERT INTO script_version (${V_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.parent_id,
    x.source_name,
    x.format,
    x.content_hash,
    x.raw_text,
    JSON.stringify(x.paragraphs.map((p) => Paragraph.parse(p))),
    x.created_at,
  );
}

export function getScriptVersion(db: DbPort, id: string): ScriptVersion | null {
  const r = db.get<VersionRow>(`SELECT ${V_COLS} FROM script_version WHERE id = ?`, id);
  return r ? versionFromRow(r) : null;
}

/** The current version = the most recently imported one. */
export function latestScriptVersion(db: DbPort): ScriptVersion | null {
  const r = db.get<VersionRow>(`SELECT ${V_COLS} FROM script_version ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  return r ? versionFromRow(r) : null;
}

export function listVersionSummaries(db: DbPort): VersionSummary[] {
  return db
    .all<{ id: string; source_name: string; content_hash: string; created_at: string; scene_count: number }>(
      `SELECT v.id, v.source_name, v.content_hash, v.created_at,
              (SELECT COUNT(*) FROM scene s WHERE s.script_version_id = v.id) AS scene_count
         FROM script_version v ORDER BY v.created_at DESC, v.rowid DESC`,
    )
    .map((r) => ({ ...r, scene_count: Number(r.scene_count) }));
}

export function insertScene(db: DbPort, s: Scene, sort: number): void {
  const x = Scene.parse(s);
  db.run(
    `INSERT INTO scene (${S_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    x.id,
    x.script_version_id,
    sort,
    x.display_no,
    x.heading,
    JSON.stringify(x.paragraph_ids),
    x.location_entity_id,
    x.time_label,
    x.screen_sides === null ? null : JSON.stringify(x.screen_sides),
    x.origin,
  );
}

export function listScenes(db: DbPort, versionId: string): SceneRecord[] {
  return db.all<SceneRow>(`SELECT ${S_COLS} FROM scene WHERE script_version_id = ? ORDER BY sort`, versionId).map(sceneFromRow);
}

export function getScene(db: DbPort, id: string): SceneRecord | null {
  const r = db.get<SceneRow>(`SELECT ${S_COLS} FROM scene WHERE id = ?`, id);
  return r ? sceneFromRow(r) : null;
}

export function updateSceneRow(
  db: DbPort,
  id: string,
  patch: { screen_sides?: ScreenSides | null; location_entity_id?: string | null },
): void {
  if (patch.screen_sides !== undefined) {
    db.run('UPDATE scene SET screen_sides_json = ? WHERE id = ?', patch.screen_sides === null ? null : JSON.stringify(patch.screen_sides), id);
  }
  if (patch.location_entity_id !== undefined) {
    db.run('UPDATE scene SET location_entity_id = ? WHERE id = ?', patch.location_entity_id, id);
  }
}

export const stripSort = ({ sort: _sort, ...scene }: SceneRecord): Scene => scene;
