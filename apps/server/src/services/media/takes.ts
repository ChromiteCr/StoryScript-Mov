import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { CreateTakeInput, Take, UpdateTakeInput } from '@storyscript/contracts';
import type { DbPort } from '../../db/port.ts';
import { getTake, insertTake, nextTakeNo, updateTakeRow } from '../../db/repos/take.ts';
import { AppError } from '../../http/errors.ts';
import { kvGet, kvPut, takeAuditKey } from './kv.ts';

/**
 * Set log (SPEC FR-07). A take is a fact written on set: shots it covers
 * (take_shot, independent of media), slate number, camera, rating, the
 * in-camera clip name and notes. Ratings never imply coverage. Corrections
 * need a reason and leave an audit entry with the previous values in kv.
 */

type CreateInput = z.infer<typeof CreateTakeInput>;
type UpdateInput = z.infer<typeof UpdateTakeInput>;

export interface TakeAuditEntry {
  /** revision after the correction */
  revision: number;
  at: string;
  reason: string;
  changed: string[];
  /** the take as it was before this correction */
  before: Take;
}

const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? '';
  return t === '' ? null : t;
};

/**
 * Hand-written shot numbers that match no shot are kept exactly as written
 * (never resolved, trimmed or merged); only blank entries are dropped.
 */
function cleanLabels(labels: readonly string[]): string[] {
  return labels.filter((l) => l.trim() !== '');
}

function checkShots(db: DbPort, shotIds: readonly string[]): string[] {
  const ids = [...new Set(shotIds)];
  for (const id of ids) {
    if (!db.get('SELECT 1 AS x FROM shot WHERE id = ?', id)) {
      throw new AppError('VALIDATION_ERROR', '条次关联了不存在的镜头', 400, { shot_id: id });
    }
  }
  return ids;
}

function checkSetup(db: DbPort, setupId: string | null): void {
  if (setupId !== null && !db.get('SELECT 1 AS x FROM setup WHERE id = ?', setupId)) {
    throw new AppError('VALIDATION_ERROR', '条次关联了不存在的机位组（setup）', 400, { setup_id: setupId });
  }
}

function requireCoverage(shotIds: readonly string[], labels: readonly string[]): void {
  if (shotIds.length === 0 && labels.length === 0) {
    throw new AppError('VALIDATION_ERROR', '条次至少要关联一个镜头，或记下对不上的手写镜号', 400);
  }
}

export function requireTake(db: DbPort, id: string): Take {
  const t = getTake(db, id);
  if (!t) throw new AppError('NOT_FOUND', '条次不存在', 404);
  return t;
}

export function createTake(db: DbPort, input: CreateInput, now = new Date().toISOString()): Take {
  return db.tx(() => {
    const shot_ids = checkShots(db, input.shot_ids);
    const unresolved_labels = cleanLabels(input.unresolved_labels);
    requireCoverage(shot_ids, unresolved_labels);
    checkSetup(db, input.setup_id);
    const take: Take = {
      id: randomUUID(),
      setup_id: input.setup_id,
      take_no: input.take_no ?? nextTakeNo(db, shot_ids, unresolved_labels),
      camera_label: blankToNull(input.camera_label),
      rating: input.rating,
      clip_hint: blankToNull(input.clip_hint),
      notes: input.notes.trim(),
      unresolved_labels,
      logged_at: now,
      shot_ids,
      revision: 0,
    };
    insertTake(db, take);
    return take;
  });
}

const FIELD_LABEL: Record<string, string> = {
  setup_id: '机位组',
  take_no: '条次号',
  camera_label: '机位',
  rating: '评级',
  clip_hint: '机内文件名',
  notes: '备注',
  shot_ids: '镜头',
  unresolved_labels: '未对上的镜号',
};

export function updateTake(db: DbPort, id: string, input: UpdateInput, now = new Date().toISOString()): Take {
  return db.tx(() => {
    const take = requireTake(db, id);
    if (take.revision !== input.expected_revision) {
      throw new AppError('REVISION_CONFLICT', '条次已被修改，请刷新后再试', 409, {
        take_id: id,
        expected_revision: input.expected_revision,
        current_revision: take.revision,
      });
    }
    const reason = input.reason.trim();
    if (!reason) throw new AppError('VALIDATION_ERROR', '修改场记必须填写原因', 400);

    const next: Take = { ...take };
    if (input.setup_id !== undefined) {
      checkSetup(db, input.setup_id);
      next.setup_id = input.setup_id;
    }
    if (input.take_no !== undefined) next.take_no = input.take_no;
    if (input.camera_label !== undefined) next.camera_label = blankToNull(input.camera_label);
    if (input.rating !== undefined) next.rating = input.rating;
    if (input.clip_hint !== undefined) next.clip_hint = blankToNull(input.clip_hint);
    if (input.notes !== undefined) next.notes = input.notes.trim();
    if (input.shot_ids !== undefined) next.shot_ids = checkShots(db, input.shot_ids);
    if (input.unresolved_labels !== undefined) next.unresolved_labels = cleanLabels(input.unresolved_labels);
    requireCoverage(next.shot_ids, next.unresolved_labels);

    const changed = (Object.keys(FIELD_LABEL) as (keyof Take)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(take[k]),
    );
    if (changed.length === 0) return take;

    next.revision = take.revision + 1;
    updateTakeRow(db, next);
    const audit = kvGet<TakeAuditEntry[]>(db, takeAuditKey(id)) ?? [];
    audit.push({ revision: next.revision, at: now, reason, changed: changed.map((k) => FIELD_LABEL[k] ?? k), before: take });
    kvPut(db, takeAuditKey(id), audit, now);
    return next;
  });
}

export function takeAudit(db: DbPort, id: string): TakeAuditEntry[] {
  return kvGet<TakeAuditEntry[]>(db, takeAuditKey(id)) ?? [];
}
