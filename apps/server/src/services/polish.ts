import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PolishMode, PolishOutput, type ApplyPolishInput, type ApplyPolishResult, type Shot, type ShotFields } from '@storyscript/contracts';
import { cleanShotFields, POLISH_MODE_LABEL, shotContentHash, validatePolish } from '@storyscript/core';
import type { DbPort } from '../db/port.ts';
import { setDraftStatus } from '../db/repos/draft.ts';
import { getShot, insertShotRevision, updateShotRow } from '../db/repos/shot.ts';
import { AppError } from '../http/errors.ts';
import { requireDraft } from './drafts.ts';
import { fieldsContext } from './shots.ts';

/**
 * Apply a polish draft (S3a), one transaction: each selected item replaces its
 * shot's fields in place (revision + 1, revision origin ai), keeping the
 * shot's own script source. Items with errors (re-checked against today's
 * roster) are refused; locked shots and shots gone since are skipped; a shot
 * edited since the request fails the whole apply with 409.
 */

export const PolishScopeSchema = z.object({
  shot_ids: z.array(z.string()),
  refs: z.record(z.string(), z.string()),
  expected_revisions: z.record(z.string(), z.number()),
  mode: PolishMode,
  instruction: z.string().nullable(),
});

/** Current shots of a polish draft, in the draft's order (the diff view's "before"). */
export function polishShots(db: DbPort, scope: unknown): Shot[] {
  const s = PolishScopeSchema.safeParse(scope);
  if (!s.success) return [];
  return s.data.shot_ids.map((id) => getShot(db, id)).filter((x): x is Shot => x !== null);
}

export function applyPolish(db: DbPort, id: string, input: ApplyPolishInput, now = new Date().toISOString()): ApplyPolishResult {
  return db.tx(() => {
    const draft = requireDraft(db, id);
    if (draft.kind !== 'polish') throw new AppError('VALIDATION_ERROR', '这不是润色草案', 400);
    if (draft.status !== 'pending') throw new AppError('VALIDATION_ERROR', `草案状态为 ${draft.status}，不能应用`, 409);
    const scope = PolishScopeSchema.safeParse(draft.scope);
    const parsed = PolishOutput.safeParse(draft.parsed);
    if (!scope.success || !parsed.success) throw new AppError('VALIDATION_ERROR', '草案没有可应用的内容', 409);
    const { refs, mode, instruction } = scope.data;

    // re-validate against today's roster and the shots as they are now
    const before: Record<string, ShotFields> = {};
    for (const [ref, shotId] of Object.entries(refs)) {
      const shot = getShot(db, shotId);
      if (shot) before[ref] = shot.fields;
    }
    const v = validatePolish(parsed.data, { refs: Object.keys(before), ...fieldsContext(db), mode, before });
    const blocked = new Set(v.issues.filter((x) => x.level === 'error' && x.item !== null).map((x) => x.item!));

    const note = instruction ? `：${[...instruction].slice(0, 60).join('')}` : '';
    const reason = `AI 润色（${POLISH_MODE_LABEL[mode]}）${note}`;
    const result: ApplyPolishResult = { updated: [], skipped_locked_ids: [], skipped_missing_ids: [] };
    for (const index of [...new Set(input.selected)].sort((a, b) => a - b)) {
      const item = parsed.data.shots[index];
      if (!item) throw new AppError('VALIDATION_ERROR', `草案中没有第 ${index + 1} 项`, 400);
      const shotId = refs[item.ref];
      if (!shotId) throw new AppError('VALIDATION_ERROR', `第 ${index + 1} 项不对应任何镜头`, 400);
      if (blocked.has(index)) throw new AppError('VALIDATION_ERROR', `第 ${index + 1} 项有错误，不能应用`, 400, { item: index });
      const shot = getShot(db, shotId);
      if (!shot || shot.archived) {
        result.skipped_missing_ids.push(shotId);
        continue;
      }
      if (shot.locked) {
        result.skipped_locked_ids.push(shot.id);
        continue;
      }
      const expected = input.expected_revisions[shot.id];
      if (expected === undefined || expected !== shot.revision) {
        throw new AppError('REVISION_CONFLICT', `镜头 ${shot.code} 在润色之后被修改过，请刷新后重新勾选`, 409, {
          shot_id: shot.id,
          expected_revision: expected ?? null,
          current_revision: shot.revision,
        });
      }
      // the source stays the shot's own: the model never sees or changes it
      const fields = cleanShotFields({ ...item.fields, source: shot.fields.source } as ShotFields);
      const hash = shotContentHash(fields);
      if (hash === shot.content_hash) continue;
      const next: Shot = { ...shot, fields, content_hash: hash, revision: shot.revision + 1, updated_at: now };
      updateShotRow(db, next);
      insertShotRevision(db, { id: randomUUID(), shot_id: next.id, revision: next.revision, fields, origin: 'ai', reason, at: now });
      result.updated.push(next);
    }
    setDraftStatus(db, draft.id, 'applied');
    return result;
  });
}
