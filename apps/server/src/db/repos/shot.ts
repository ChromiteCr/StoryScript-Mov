import { Shot, ShotRevision, SourceAnchor } from '@storyscript/contracts';
import { actorId, actorResolver } from '../../collab/actor.ts';
import type { DbPort } from '../port.ts';

/** shot / shot_revision ↔ contracts. Every revision bump writes one shot_revision row. */

interface ShotRow {
  id: string;
  scene_id: string;
  code: string;
  narrative_pos: number;
  source_anchor_json: string | null;
  manual_note: string | null;
  origin: string;
  fields_json: string;
  locked: number;
  archived: number;
  required_status: string;
  requirement_reason: string | null;
  setup_id: string | null;
  needs_relink: number;
  content_hash: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  shot_id: string;
  revision: number;
  fields_json: string;
  origin: string;
  reason: string | null;
  at: string;
  actor_id: string | null;
}

const COLS =
  'id, scene_id, code, narrative_pos, source_anchor_json, manual_note, origin, fields_json, locked, archived, required_status, requirement_reason, setup_id, needs_relink, content_hash, revision, created_at, updated_at';
const S_COLS = COLS.split(', ')
  .map((c) => `s.${c}`)
  .join(', ');

function fromRow(r: ShotRow): Shot {
  return Shot.parse({
    ...r,
    source_anchor: r.source_anchor_json === null ? null : SourceAnchor.parse(JSON.parse(r.source_anchor_json)),
    fields: JSON.parse(r.fields_json),
    locked: r.locked === 1,
    archived: r.archived === 1,
    needs_relink: r.needs_relink === 1,
  });
}

/** All non-archived shots, ordered by scene order then narrative order. */
export function listActiveShots(db: DbPort): Shot[] {
  return db
    .all<ShotRow>(
      `SELECT ${S_COLS} FROM shot s JOIN scene sc ON sc.id = s.scene_id
        WHERE s.archived = 0
        ORDER BY sc.script_version_id = (SELECT id FROM script_version ORDER BY created_at DESC, rowid DESC LIMIT 1) DESC,
                 sc.sort, s.narrative_pos, s.created_at, s.rowid`,
    )
    .map(fromRow);
}

export function listSceneShots(db: DbPort, sceneId: string, opts: { includeArchived?: boolean } = {}): Shot[] {
  return db
    .all<ShotRow>(
      `SELECT ${COLS} FROM shot WHERE scene_id = ? ${opts.includeArchived ? '' : 'AND archived = 0'}
        ORDER BY narrative_pos, created_at, rowid`,
      sceneId,
    )
    .map(fromRow);
}

export function getShot(db: DbPort, id: string): Shot | null {
  const r = db.get<ShotRow>(`SELECT ${COLS} FROM shot WHERE id = ?`, id);
  return r ? fromRow(r) : null;
}

function values(x: Shot) {
  return [
    x.id,
    x.scene_id,
    x.code,
    x.narrative_pos,
    x.source_anchor === null ? null : JSON.stringify(x.source_anchor),
    x.manual_note,
    x.origin,
    JSON.stringify(x.fields),
    x.locked ? 1 : 0,
    x.archived ? 1 : 0,
    x.required_status,
    x.requirement_reason,
    x.setup_id,
    x.needs_relink ? 1 : 0,
    x.content_hash,
    x.revision,
    x.created_at,
    x.updated_at,
  ] as const;
}

export function insertShot(db: DbPort, s: Shot): void {
  const x = Shot.parse(s);
  db.run(`INSERT INTO shot (${COLS}) VALUES (${COLS.split(', ').map(() => '?').join(', ')})`, ...values(x));
}

/** Overwrite every column of an existing shot (callers own revision bookkeeping). */
export function updateShotRow(db: DbPort, s: Shot): void {
  const x = Shot.parse(s);
  const [id, ...rest] = values(x);
  const sets = COLS.split(', ')
    .slice(1)
    .map((c) => `${c} = ?`)
    .join(', ');
  db.run(`UPDATE shot SET ${sets} WHERE id = ?`, ...rest, id);
}

export function insertShotRevision(db: DbPort, r: ShotRevision): void {
  const x = ShotRevision.parse(r);
  db.run(
    'INSERT INTO shot_revision (id, shot_id, revision, fields_json, origin, reason, at, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    x.id,
    x.shot_id,
    x.revision,
    JSON.stringify(x.fields),
    x.origin,
    x.reason,
    x.at,
    actorId(),
  );
}

export function listShotRevisions(db: DbPort, shotId: string): ShotRevision[] {
  const who = actorResolver(db);
  return db
    .all<RevisionRow>(
      'SELECT id, shot_id, revision, fields_json, origin, reason, at, actor_id FROM shot_revision WHERE shot_id = ? ORDER BY revision',
      shotId,
    )
    .map((r) => ShotRevision.parse({ ...r, fields: JSON.parse(r.fields_json), actor: who(r.actor_id) }));
}

/** Highest trailing number among the scene's non-archived shot codes. */
export function maxShotNumber(db: DbPort, sceneId: string): number {
  let max = 0;
  for (const r of db.all<{ code: string }>('SELECT code FROM shot WHERE scene_id = ? AND archived = 0', sceneId)) {
    const m = /(\d+)\s*$/.exec(r.code);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

export function maxNarrativePos(db: DbPort, sceneId: string): number {
  const r = db.get<{ p: number | null }>('SELECT MAX(narrative_pos) AS p FROM shot WHERE scene_id = ? AND archived = 0', sceneId);
  return Number(r?.p ?? 0);
}

export const formatShotCode = (n: number) => String(n).padStart(3, '0');
