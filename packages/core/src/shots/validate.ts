import type { BreakdownOutput, DraftIssue, ShotFields } from '@storyscript/contracts';
import { flagFilmClaims, type ClaimFlag } from '../prompt/claims.ts';
import { matchQuote, normalizeForMatch, type QuoteLevel } from '../script/quote.ts';

/**
 * Business validation of a (zod-valid, normalised) BreakdownOutput for one
 * scene (SPEC FR-03 steps 3–5). Errors make an item non-applicable and are fed
 * back to the model in the repair round; warnings are shown in the diff view.
 */

export const EST_SECONDS_MAX = 120;
export const MAX_PROPS = 4;
export const MAX_SUBJECTS = 4;
export const CAMERA_NOTES_MAX = 300;

export interface ShotFieldsContext {
  /** character aliases of the roster (c1, c2 …) */
  aliases: readonly string[];
  technique_ids: readonly string[];
}

export interface BreakdownValidationContext extends ShotFieldsContext {
  /** paragraphs of this scene only */
  paragraphs: readonly { id: string; text: string }[];
  max_shots: number;
  /** the user's "reference X" note; its presence marks the draft as unverified advice */
  reference_note?: string | null;
}

export interface ItemClaimFlag {
  item: number | null;
  kind: ClaimFlag['kind'];
  text: string;
}

export interface ValidatedItem {
  fields: ShotFields;
  quote_match: QuoteLevel;
  issues: DraftIssue[];
}

export interface BreakdownValidation {
  items: ValidatedItem[];
  /** every issue (item-level ones carry their item index; draft-level ones item=null) */
  issues: DraftIssue[];
  claim_flags: ItemClaimFlag[];
  error_count: number;
}

const issue = (level: DraftIssue['level'], code: string, message: string, item: number | null): DraftIssue => ({
  level,
  code,
  message,
  item,
});

/** Checks shared by AI items and manual shots: roster aliases, technique ids, duration. */
export function validateShotFieldsBasic(fields: ShotFields, ctx: ShotFieldsContext, item: number | null = null): DraftIssue[] {
  const out: DraftIssue[] = [];
  const roster = new Set(ctx.aliases);
  const seen = new Set<string>();
  for (const s of fields.subjects) {
    if (!roster.has(s.alias)) {
      out.push(issue('error', 'unknown_alias', `subjects 使用了角色名单外的别名「${s.alias}」`, item));
    } else if (seen.has(s.alias)) {
      out.push(issue('warning', 'duplicate_subject', `subjects 中「${s.alias}」出现了不止一次`, item));
    }
    seen.add(s.alias);
  }
  if (fields.pov_owner !== null && !roster.has(fields.pov_owner)) {
    out.push(issue('error', 'unknown_pov_owner', `pov_owner「${fields.pov_owner}」不在角色名单中`, item));
  }
  if (fields.technique_id !== null && !ctx.technique_ids.includes(fields.technique_id)) {
    out.push(issue('error', 'unknown_technique', `technique_id「${fields.technique_id}」不是可用手法`, item));
  }
  if (!Number.isFinite(fields.est_seconds) || fields.est_seconds <= 0 || fields.est_seconds > EST_SECONDS_MAX) {
    out.push(issue('error', 'est_seconds_out_of_range', `est_seconds 应在 (0, ${EST_SECONDS_MAX}] 秒之间，当前为 ${fields.est_seconds}`, item));
  }
  if (fields.props.length > MAX_PROPS) {
    out.push(issue('warning', 'too_many_props', `props 有 ${fields.props.length} 个，建议不超过 ${MAX_PROPS} 个`, item));
  }
  if (fields.subjects.length > MAX_SUBJECTS) {
    out.push(issue('warning', 'too_many_subjects', `subjects 有 ${fields.subjects.length} 个，建议不超过 ${MAX_SUBJECTS} 个`, item));
  }
  if (fields.focal_mm !== null && (!Number.isFinite(fields.focal_mm) || fields.focal_mm < 8 || fields.focal_mm > 800)) {
    out.push(issue('warning', 'focal_out_of_range', `focal_mm=${fields.focal_mm} 超出常见范围（8–800mm）`, item));
  }
  const n = fields.subjects.length;
  if (fields.template === 'single' && n > 1) {
    out.push(issue('warning', 'template_subjects', `single 模板通常只有 1 个人物，当前 ${n} 个`, item));
  }
  if ((fields.template === 'two_shot' || fields.template === 'ots') && n < 2) {
    out.push(issue('warning', 'template_subjects', `${fields.template} 模板通常需要 2 个人物，当前 ${n} 个`, item));
  }
  if (typeof fields.camera_notes === 'string' && fields.camera_notes.length > CAMERA_NOTES_MAX) {
    out.push(issue('warning', 'camera_notes_long', `拍法说明超过 ${CAMERA_NOTES_MAX} 字（当前 ${fields.camera_notes.length} 字）`, item));
  }
  if (!fields.narrative_purpose.trim()) out.push(issue('warning', 'empty_text', 'narrative_purpose 为空', item));
  if (!fields.action.trim()) out.push(issue('warning', 'empty_text', 'action 为空', item));
  return out;
}

/** Claim flags over the model's free text (annotate only, never block). */
export function breakdownClaimFlags(shots: readonly Pick<ShotFields, 'narrative_purpose' | 'action' | 'assumptions'>[]): ItemClaimFlag[] {
  const out: ItemClaimFlag[] = [];
  shots.forEach((s, i) => {
    for (const text of [s.narrative_purpose, s.action, ...s.assumptions]) {
      for (const f of flagFilmClaims(text)) out.push({ item: i, kind: f.kind, text: f.text });
    }
  });
  return out;
}

export function validateBreakdown(parsed: BreakdownOutput, ctx: BreakdownValidationContext): BreakdownValidation {
  const paragraphs = new Map(ctx.paragraphs.map((p) => [p.id, p.text]));
  const sceneText = normalizeForMatch(ctx.paragraphs.map((p) => p.text).join('\n'));
  const all: DraftIssue[] = [];
  const items: ValidatedItem[] = parsed.shots.map((fields, i) => {
    const issues = validateShotFieldsBasic(fields, ctx, i);
    let quote_match: QuoteLevel = 'rejected';
    const text = paragraphs.get(fields.source.paragraph_id);
    if (text === undefined) {
      const elsewhere = ctx.paragraphs.find((p) => matchQuote(fields.source.quote, p.text).level === 'exact');
      issues.push(
        issue(
          'error',
          'paragraph_not_in_scene',
          `source.paragraph_id「${fields.source.paragraph_id}」不是本场的段落` +
            (elsewhere ? `（引用原文出现在 ${elsewhere.id}）` : ''),
          i,
        ),
      );
    } else {
      const m = matchQuote(fields.source.quote, text);
      quote_match = m.level;
      if (m.level === 'rejected') {
        issues.push(issue('error', 'quote_rejected', `source.quote 在段落 ${fields.source.paragraph_id} 中找不到（需逐字复制原文）`, i));
      } else if (m.level === 'fuzzy') {
        issues.push(issue('warning', 'quote_fuzzy', `source.quote 与段落 ${fields.source.paragraph_id} 原文有 ${m.distance} 处出入`, i));
      }
    }
    if (fields.dialogue_quote !== null) {
      const d = normalizeForMatch(fields.dialogue_quote);
      if (d && !sceneText.includes(d)) {
        issues.push(issue('warning', 'dialogue_not_in_scene', 'dialogue_quote 与本场台词原文不一致', i));
      }
    }
    if (i >= ctx.max_shots) {
      issues.push(issue('error', 'too_many_shots', `超出镜头数量上限 ${ctx.max_shots}（第 ${i + 1} 个）`, i));
    }
    all.push(...issues);
    return { fields, quote_match, issues };
  });

  if (parsed.shots.length === 0) {
    all.push(issue('error', 'empty_breakdown', '没有输出任何镜头', null));
  }
  if (parsed.shots.length > ctx.max_shots) {
    all.push(issue('error', 'too_many_shots', `共 ${parsed.shots.length} 个镜头，超过上限 ${ctx.max_shots}`, null));
  }
  if (ctx.reference_note && ctx.reference_note.trim()) {
    all.push(
      issue(
        'warning',
        'reference_unverified',
        '通用手法建议（未核实）：风格要求只作为风格方向，输出不代表任何具体影片的真实做法',
        null,
      ),
    );
  }
  return {
    items,
    issues: all,
    claim_flags: breakdownClaimFlags(parsed.shots),
    error_count: all.filter((x) => x.level === 'error').length,
  };
}

/** Error messages for the structuredCall repair round ("镜头 #3：…"). */
export function breakdownRepairErrors(v: BreakdownValidation): string[] {
  return v.issues
    .filter((x) => x.level === 'error')
    .map((x) => (x.item === null ? x.message : `镜头 #${x.item + 1}：${x.message}`));
}

/** Indices of items that carry at least one error. */
export function itemsWithErrors(v: BreakdownValidation): number[] {
  return v.items.flatMap((it, i) => (it.issues.some((x) => x.level === 'error') ? [i] : []));
}
