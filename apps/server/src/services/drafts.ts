import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BreakdownOutput,
  BreakdownRequest,
  PolishOutput,
  type ApplyBreakdownInput,
  type ApplyBreakdownResult,
  type DraftDetail,
  type Shot,
  type ShotDraft,
} from '@storyscript/contracts';
import { breakdownClaimFlags, cleanShotFields, shotContentHash, validateBreakdown } from '@storyscript/core';
import type { DbPort } from '../db/port.ts';
import { getDraft, setDraftStatus } from '../db/repos/draft.ts';
import { getScriptVersion, latestScriptVersion } from '../db/repos/script.ts';
import {
  formatShotCode,
  insertShot,
  insertShotRevision,
  listSceneShots,
  maxNarrativePos,
  maxShotNumber,
  updateShotRow,
} from '../db/repos/shot.ts';
import { AppError } from '../http/errors.ts';
import { polishShots } from './polish.ts';
import { fieldsContext, requireScene } from './shots.ts';

/**
 * Draft review and apply (INV-03). apply is one transaction:
 *   - only selected items without errors (re-validated against today's roster);
 *   - locked shots are never touched;
 *   - replace_existing archives the scene's unlocked AI shots, each of which
 *     must be listed in expected_revisions with its current revision — any
 *     mismatch fails the whole apply with 409 and changes nothing.
 */

const BreakdownScope = z.object({ scene_id: z.string(), script_version_id: z.string(), request: BreakdownRequest });

type Input<S extends z.ZodType> = z.infer<S>;

export function requireDraft(db: DbPort, id: string): ShotDraft {
  const d = getDraft(db, id);
  if (!d) throw new AppError('NOT_FOUND', '草案不存在', 404);
  return d;
}

export function draftDetail(db: DbPort, id: string): DraftDetail {
  const draft = requireDraft(db, id);
  if (draft.kind === 'polish') {
    const parsed = PolishOutput.safeParse(draft.parsed);
    return {
      draft,
      current_shots: polishShots(db, draft.scope),
      claim_flags: parsed.success ? breakdownClaimFlags(parsed.data.shots.map((x) => x.fields)) : [],
    };
  }
  if (draft.kind !== 'breakdown') return { draft, current_shots: [], claim_flags: [] };
  const scope = BreakdownScope.safeParse(draft.scope);
  const parsed = BreakdownOutput.safeParse(draft.parsed);
  return {
    draft,
    current_shots: scope.success ? listSceneShots(db, scope.data.scene_id) : [],
    claim_flags: parsed.success ? breakdownClaimFlags(parsed.data.shots) : [],
  };
}

export function discardDraft(db: DbPort, id: string): ShotDraft {
  return db.tx(() => {
    const draft = requireDraft(db, id);
    if (draft.status === 'discarded') return draft;
    if (draft.status !== 'pending' && draft.status !== 'failed') {
      throw new AppError('VALIDATION_ERROR', `草案状态为 ${draft.status}，不能丢弃`, 409);
    }
    setDraftStatus(db, id, 'discarded');
    return { ...draft, status: 'discarded' };
  });
}

export function applyBreakdown(db: DbPort, id: string, input: Input<typeof ApplyBreakdownInput>, now = new Date().toISOString()): ApplyBreakdownResult {
  return db.tx(() => {
    const draft = requireDraft(db, id);
    if (draft.kind !== 'breakdown') throw new AppError('VALIDATION_ERROR', '这不是拆镜草案', 400);
    if (draft.status !== 'pending') throw new AppError('VALIDATION_ERROR', `草案状态为 ${draft.status}，不能应用`, 409);
    const scope = BreakdownScope.safeParse(draft.scope);
    const parsed = BreakdownOutput.safeParse(draft.parsed);
    if (!scope.success || !parsed.success) throw new AppError('VALIDATION_ERROR', '草案没有可应用的内容', 409);
    const scene = requireScene(db, scope.data.scene_id);
    const latest = latestScriptVersion(db);
    if (!latest || latest.id !== scene.script_version_id || scope.data.script_version_id !== scene.script_version_id) {
      throw new AppError('VALIDATION_ERROR', '剧本已更新，这份草案基于旧版本，请重新拆镜', 409);
    }
    const version = getScriptVersion(db, scene.script_version_id)!;
    const ids = new Set(scene.paragraph_ids);
    const v = validateBreakdown(parsed.data, {
      paragraphs: version.paragraphs.filter((p) => ids.has(p.id)),
      ...fieldsContext(db),
      max_shots: scope.data.request.max_shots,
    });

    const selected = [...new Set(input.selected)].sort((a, b) => a - b);
    const outOfRange = selected.filter((i) => i >= v.items.length);
    if (outOfRange.length) throw new AppError('VALIDATION_ERROR', `草案中没有第 ${outOfRange.map((i) => i + 1).join('、')} 条`, 400);
    const bad = selected.filter((i) => v.items[i]!.issues.some((x) => x.level === 'error'));
    if (bad.length) {
      throw new AppError('VALIDATION_ERROR', `第 ${bad.map((i) => i + 1).join('、')} 条带有错误，不能应用`, 400, {
        items: bad,
        issues: v.issues.filter((x) => x.level === 'error' && x.item !== null && bad.includes(x.item)),
      });
    }

    const existing = listSceneShots(db, scene.id);
    const locked = existing.filter((s) => s.locked);
    const toArchive = input.replace_existing ? existing.filter((s) => !s.locked && s.origin === 'ai') : [];
    const conflicts = toArchive.filter((s) => input.expected_revisions[s.id] !== s.revision);
    if (conflicts.length) {
      throw new AppError('REVISION_CONFLICT', '本场镜头已被修改，请刷新后再应用', 409, {
        conflicts: conflicts.map((s) => ({ shot_id: s.id, expected_revision: input.expected_revisions[s.id] ?? null, current_revision: s.revision })),
      });
    }

    for (const s of toArchive) {
      const next: Shot = { ...s, archived: true, revision: s.revision + 1, updated_at: now };
      updateShotRow(db, next);
      insertShotRevision(db, {
        id: randomUUID(),
        shot_id: s.id,
        revision: next.revision,
        fields: s.fields,
        origin: s.origin,
        reason: `归档：被拆镜草案 ${draft.id.slice(0, 8)} 替换`,
        at: now,
      });
    }

    let code = maxShotNumber(db, scene.id);
    let pos = maxNarrativePos(db, scene.id);
    const created: Shot[] = [];
    for (const i of selected) {
      const item = v.items[i]!;
      const match = item.quote_match === 'fuzzy' ? 'fuzzy' : 'exact';
      const shot: Shot = {
        id: randomUUID(),
        scene_id: scene.id,
        code: formatShotCode(++code),
        narrative_pos: ++pos,
        source_anchor: {
          script_version_id: version.id,
          paragraph_id: item.fields.source.paragraph_id,
          quote: item.fields.source.quote,
          match,
        },
        manual_note: null,
        origin: 'ai',
        fields: cleanShotFields(item.fields),
        locked: false,
        archived: false,
        required_status: 'required',
        requirement_reason: null,
        setup_id: null,
        needs_relink: false,
        content_hash: shotContentHash(item.fields),
        revision: 0,
        created_at: now,
        updated_at: now,
      };
      insertShot(db, shot);
      insertShotRevision(db, {
        id: randomUUID(),
        shot_id: shot.id,
        revision: 0,
        fields: shot.fields,
        origin: 'ai',
        reason: `应用拆镜草案 ${draft.id.slice(0, 8)} 第 ${i + 1} 条`,
        at: now,
      });
      created.push(shot);
    }
    setDraftStatus(db, draft.id, 'applied');
    return {
      created,
      archived_ids: toArchive.map((s) => s.id),
      skipped_locked_ids: input.replace_existing ? locked.map((s) => s.id) : [],
    };
  });
}
