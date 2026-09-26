import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type {
  ArchiveShotInput,
  CreateShotInput,
  NarrativeOrderInput,
  Origin,
  SetRequirementInput,
  Shot,
  ShotFields,
  SourceAnchor,
  Technique,
  UpdateShotInput,
} from '@storyscript/contracts';
import { shotContentHash, TECHNIQUES, validateShotFieldsBasic } from '@storyscript/core';
import type { DbPort } from '../db/port.ts';
import { characterRoster } from '../db/repos/entity.ts';
import { getScene, getScriptVersion, type SceneRecord } from '../db/repos/script.ts';
import {
  formatShotCode,
  getShot,
  insertShot,
  insertShotRevision,
  listSceneShots,
  maxNarrativePos,
  maxShotNumber,
  updateShotRow,
} from '../db/repos/shot.ts';
import { AppError } from '../http/errors.ts';

/**
 * Manual shot operations (SPEC FR-03). Writes that carry expected_revision
 * bump the revision and append a shot_revision row; narrative order does not
 * (INV-01: it only touches narrative_pos). Locked shots refuse content edits
 * and archiving.
 */

type Input<S extends z.ZodType> = z.infer<S>;

export type TechniqueRef = Pick<Technique, 'id' | 'name' | 'shot_grammar'>;

/** Built-in techniques plus user-authored ones from the technique table. */
export function availableTechniques(db: DbPort): TechniqueRef[] {
  const user = db.all<{ id: string; name: string; shot_grammar: string }>('SELECT id, name, shot_grammar FROM technique ORDER BY id');
  return [...TECHNIQUES.map((t) => ({ id: t.id, name: t.name, shot_grammar: t.shot_grammar })), ...user];
}

export function fieldsContext(db: DbPort) {
  return { aliases: characterRoster(db).map((r) => r.alias), technique_ids: availableTechniques(db).map((t) => t.id) };
}

export function requireScene(db: DbPort, id: string): SceneRecord {
  const s = getScene(db, id);
  if (!s) throw new AppError('NOT_FOUND', '场景不存在', 404);
  return s;
}

export function requireShot(db: DbPort, id: string): Shot {
  const s = getShot(db, id);
  if (!s) throw new AppError('NOT_FOUND', '镜头不存在', 404);
  return s;
}

function checkFields(db: DbPort, fields: ShotFields): void {
  const errors = validateShotFieldsBasic(fields, fieldsContext(db)).filter((i) => i.level === 'error');
  if (errors.length) {
    throw new AppError('VALIDATION_ERROR', errors.map((e) => e.message).join('；'), 400, { issues: errors });
  }
}

function checkRevision(shot: Shot, expected: number): void {
  if (shot.revision !== expected) {
    throw new AppError('REVISION_CONFLICT', '镜头已被修改，请刷新后再试', 409, {
      shot_id: shot.id,
      expected_revision: expected,
      current_revision: shot.revision,
    });
  }
}

/** Human-asserted anchor for a manual source: only when the paragraph belongs to the scene. */
function manualAnchor(db: DbPort, scene: SceneRecord, source: ShotFields['source']): SourceAnchor | null {
  if (!source.quote.trim() || !scene.paragraph_ids.includes(source.paragraph_id)) return null;
  const version = getScriptVersion(db, scene.script_version_id);
  if (!version) return null;
  return { script_version_id: version.id, paragraph_id: source.paragraph_id, quote: source.quote, match: 'manual' };
}

function writeRevision(db: DbPort, shot: Shot, origin: Origin, reason: string | null, at: string): void {
  insertShotRevision(db, { id: randomUUID(), shot_id: shot.id, revision: shot.revision, fields: shot.fields, origin, reason, at });
}

export function createShot(db: DbPort, input: Input<typeof CreateShotInput>, now = new Date().toISOString()): Shot {
  return db.tx(() => {
    const scene = requireScene(db, input.scene_id);
    checkFields(db, input.fields);
    const shot: Shot = {
      id: randomUUID(),
      scene_id: scene.id,
      code: input.code?.trim() || formatShotCode(maxShotNumber(db, scene.id) + 1),
      narrative_pos: maxNarrativePos(db, scene.id) + 1,
      source_anchor: manualAnchor(db, scene, input.fields.source),
      manual_note: input.manual_note,
      origin: 'manual',
      fields: input.fields,
      locked: false,
      archived: false,
      required_status: 'required',
      requirement_reason: null,
      setup_id: null,
      needs_relink: false,
      content_hash: shotContentHash(input.fields),
      revision: 0,
      created_at: now,
      updated_at: now,
    };
    insertShot(db, shot);
    writeRevision(db, shot, 'manual', input.manual_note, now);
    return shot;
  });
}

export function updateShot(db: DbPort, id: string, input: Input<typeof UpdateShotInput>, now = new Date().toISOString()): Shot {
  return db.tx(() => {
    const shot = requireShot(db, id);
    checkRevision(shot, input.expected_revision);
    const fieldsChanged = input.fields !== undefined && shotContentHash(input.fields) !== shot.content_hash;
    const codeChanged = input.code !== undefined && input.code.trim() !== shot.code;
    const lockChanged = input.locked !== undefined && input.locked !== shot.locked;
    if (!fieldsChanged && !codeChanged && !lockChanged) return shot;
    const unlocking = lockChanged && input.locked === false;
    if (shot.locked && !unlocking && (fieldsChanged || codeChanged)) {
      throw new AppError('LOCKED_SHOT', '镜头已锁定，先解锁再修改', 409, { shot_id: shot.id });
    }
    if (shot.archived && (fieldsChanged || codeChanged)) {
      throw new AppError('VALIDATION_ERROR', '镜头已归档，不能修改', 409, { shot_id: shot.id });
    }
    const next: Shot = { ...shot, revision: shot.revision + 1, updated_at: now };
    const reasons: string[] = [];
    if (fieldsChanged) {
      checkFields(db, input.fields!);
      next.fields = input.fields!;
      next.content_hash = shotContentHash(input.fields!);
      const sourceChanged =
        input.fields!.source.paragraph_id !== shot.fields.source.paragraph_id || input.fields!.source.quote !== shot.fields.source.quote;
      if (sourceChanged) {
        const anchor = manualAnchor(db, requireScene(db, shot.scene_id), input.fields!.source);
        next.source_anchor = anchor;
        if (anchor) next.needs_relink = false;
      }
      reasons.push('修改内容');
    }
    if (codeChanged) {
      next.code = input.code!.trim();
      reasons.push(`编号 ${shot.code} → ${next.code}`);
    }
    if (lockChanged) {
      next.locked = input.locked!;
      reasons.push(input.locked ? '锁定' : '解锁');
    }
    updateShotRow(db, next);
    const reason = input.reason?.trim() || reasons.join('；');
    writeRevision(db, next, fieldsChanged ? 'manual' : shot.origin, reason, now);
    return next;
  });
}

export function archiveShot(db: DbPort, id: string, input: Input<typeof ArchiveShotInput>, now = new Date().toISOString()): Shot {
  return db.tx(() => {
    const shot = requireShot(db, id);
    checkRevision(shot, input.expected_revision);
    if (shot.archived) return shot;
    if (shot.locked) throw new AppError('LOCKED_SHOT', '镜头已锁定，不能归档', 409, { shot_id: shot.id });
    const next: Shot = { ...shot, archived: true, revision: shot.revision + 1, updated_at: now };
    updateShotRow(db, next);
    writeRevision(db, next, shot.origin, `归档：${input.reason}`, now);
    return next;
  });
}

const STATUS_LABEL = { required: '必拍', optional: '可选', waived: '免拍' } as const;

export function setRequirement(db: DbPort, id: string, input: Input<typeof SetRequirementInput>, now = new Date().toISOString()): Shot {
  return db.tx(() => {
    const shot = requireShot(db, id);
    checkRevision(shot, input.expected_revision);
    const reason = input.reason.trim();
    if (!reason) throw new AppError('VALIDATION_ERROR', '修改必拍状态必须填写原因', 400);
    const next: Shot = {
      ...shot,
      required_status: input.required_status,
      requirement_reason: reason,
      revision: shot.revision + 1,
      updated_at: now,
    };
    updateShotRow(db, next);
    writeRevision(db, next, shot.origin, `${STATUS_LABEL[input.required_status]}：${reason}`, now);
    return next;
  });
}

/** Rewrites narrative_pos only (INV-01); the full set of the scene's active shots is required. */
export function setNarrativeOrder(db: DbPort, input: Input<typeof NarrativeOrderInput>, now = new Date().toISOString()): Shot[] {
  return db.tx(() => {
    requireScene(db, input.scene_id);
    const current = listSceneShots(db, input.scene_id);
    const ids = new Set(input.shot_ids);
    if (ids.size !== input.shot_ids.length) throw new AppError('VALIDATION_ERROR', 'shot_ids 中有重复', 400);
    const expected = new Set(current.map((s) => s.id));
    if (ids.size !== expected.size || [...ids].some((id) => !expected.has(id))) {
      throw new AppError('VALIDATION_ERROR', 'shot_ids 必须恰好是本场全部未归档镜头', 400, {
        expected: [...expected],
      });
    }
    const byId = new Map(current.map((s) => [s.id, s]));
    input.shot_ids.forEach((id, i) => {
      const s = byId.get(id)!;
      if (s.narrative_pos !== i + 1) db.run('UPDATE shot SET narrative_pos = ?, updated_at = ? WHERE id = ?', i + 1, now, id);
    });
    return listSceneShots(db, input.scene_id);
  });
}
