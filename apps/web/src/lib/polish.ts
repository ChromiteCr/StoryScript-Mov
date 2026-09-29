import {
  POLISH_MAX_SHOTS,
  PolishMode,
  PolishOutput,
  StyleLevel,
  type ApplyPolishResult,
  type DraftDetail,
  type DraftIssue,
  type PolishedShotFields,
  type Shot,
  type ShotDraft,
  type ShotFields,
} from '@storyscript/contracts';
import { TECHNIQUES } from '@storyscript/core';
import type { InputOf } from './api.ts';
import {
  DEPTH_LABEL,
  ENV_LABEL,
  FACING_LABEL,
  FRAME_FORMAT_LABEL,
  POSE_LABEL,
  PROP_LABEL,
  SCREEN_POS_LABEL,
  SHOT_FIELD_LABEL,
  SUBJECT_MOTION_LABEL,
  TEMPLATE_LABEL,
  shotSpecLine,
} from './labels.ts';
import { changedFieldKeys } from './shots.ts';

/**
 * Pure helpers for AI polish (S3a): the shot table's selection, what a polish
 * draft shows (before / after per shot) and the body of the apply request.
 * No DOM, no fetch.
 */

/** One request polishes at most this many shots (server: POLISH_MAX_SHOTS). */
export const POLISH_MAX = POLISH_MAX_SHOTS;

// ---------------------------------------------------------------- selection --

type ShotFlags = Pick<Shot, 'id' | 'locked' | 'archived'>;
export type ShotIdSet = ReadonlySet<string>;

/** Shots that can be ticked: live and not locked (a locked shot is never polished). */
export function selectableShotIds(shots: readonly ShotFlags[]): Set<string> {
  return new Set(shots.filter((s) => !s.locked && !s.archived).map((s) => s.id));
}

/** Tick or untick one shot; an id that cannot be ticked is never added. */
export function toggleShot(selected: ShotIdSet, id: string, selectable: ShotIdSet): ShotIdSet {
  if (selected.has(id)) {
    const next = new Set(selected);
    next.delete(id);
    return next;
  }
  if (!selectable.has(id)) return selected;
  return new Set(selected).add(id);
}

/** Tick or untick several shots; ids that cannot be ticked are skipped. Same set back when nothing changes. */
export function setShots(selected: ShotIdSet, ids: readonly string[], on: boolean, selectable: ShotIdSet): ShotIdSet {
  const next = new Set(selected);
  for (const id of ids) {
    if (!on) next.delete(id);
    else if (selectable.has(id)) next.add(id);
  }
  return next.size === selected.size && [...next].every((id) => selected.has(id)) ? selected : next;
}

/** Drop ids that can no longer be ticked (deleted, archived, locked). Same set back when nothing is dropped. */
export function pruneSelection(selected: ShotIdSet, selectable: ShotIdSet): ShotIdSet {
  for (const id of selected) {
    if (!selectable.has(id)) return new Set([...selected].filter((x) => selectable.has(x)));
  }
  return selected;
}

export interface SceneSelection {
  /** the scene's tickable shots (locked ones are left out), in the given order */
  ids: string[];
  selectedCount: number;
  /** every tickable shot is ticked (false when there is none) */
  all: boolean;
}

/** State of a scene's 全选本场 / 取消本场 button. */
export function sceneSelection(sceneShots: readonly ShotFlags[], selected: ShotIdSet): SceneSelection {
  const ids = sceneShots.filter((s) => !s.locked && !s.archived).map((s) => s.id);
  const selectedCount = ids.filter((id) => selected.has(id)).length;
  return { ids, selectedCount, all: ids.length > 0 && selectedCount === ids.length };
}

type AiGateLike = { enabled: boolean; reason: string | null; demo?: boolean };

/** Why the model cannot be asked to polish at all (no model configured; the demo replays recorded breakdowns only); null when it can. */
export function polishAiReason(ai: AiGateLike): string | null {
  if (!ai.enabled) return ai.reason ?? 'AI 暂时不可用';
  if (ai.demo) return '演示模式不连接模型，不能润色镜头';
  return null;
}

/** Why AI 润色 cannot start with `count` shots ticked; null when it can (count 0 is handled by the caller). */
export function polishBlockedReason(count: number, ai: AiGateLike): string | null {
  return polishAiReason(ai) ?? (count > POLISH_MAX ? `一次最多 ${POLISH_MAX} 个` : null);
}

export function canPolish(count: number, ai: AiGateLike): boolean {
  return count > 0 && polishBlockedReason(count, ai) === null;
}

/** "将发送这 3 个镜头的内容和出处段落、角色名单（2 人）、风格说明（惊悚压迫）、你写的润色要求到" */
export function polishOutgoingSentence(a: { shots: number; characters: number; styleName: string | null; hasInstruction: boolean }): string {
  const items = [`这 ${a.shots} 个镜头的内容和出处段落`, `角色名单（${a.characters} 人）`];
  if (a.styleName) items.push(`风格说明（${a.styleName}）`);
  if (a.hasInstruction) items.push('你写的润色要求');
  return `将发送${items.join('、')}到`;
}

// ------------------------------------------------------------------- drafts --

/** Pending polish drafts, newest first. Breakdown drafts (pendingDraftByScene) are a different list. */
export function pendingPolishDrafts<D extends Pick<ShotDraft, 'kind' | 'status' | 'created_at'>>(drafts: readonly D[]): D[] {
  return drafts.filter((d) => d.kind === 'polish' && d.status === 'pending').sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export interface PolishScopeView {
  mode: PolishMode | null;
  instruction: string | null;
  styleId: string | null;
  level: StyleLevel | null;
  /** ref (s1 …) → shot id */
  refs: Record<string, string>;
  /** shot id → revision when the request was made */
  expected: Record<string, number>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The draft's free-form scope, read defensively. */
export function readPolishScope(scope: Record<string, unknown>): PolishScopeView {
  const mode = PolishMode.safeParse(scope.mode);
  const level = StyleLevel.safeParse(scope.level);
  const refs: Record<string, string> = {};
  if (isRecord(scope.refs)) for (const [k, v] of Object.entries(scope.refs)) if (typeof v === 'string') refs[k] = v;
  const expected: Record<string, number> = {};
  if (isRecord(scope.expected_revisions)) for (const [k, v] of Object.entries(scope.expected_revisions)) if (typeof v === 'number') expected[k] = v;
  return {
    mode: mode.success ? mode.data : null,
    instruction: typeof scope.instruction === 'string' && scope.instruction.trim() !== '' ? scope.instruction : null,
    styleId: typeof scope.style_id === 'string' ? scope.style_id : null,
    level: level.success ? level.data : null,
    refs,
    expected,
  };
}

export interface PolishItem {
  /** index into draft.parsed.shots (what apply sends) */
  index: number;
  ref: string;
  /** the shot as it is now; null when it is gone */
  shot: Shot | null;
  before: PolishedShotFields | null;
  /** the model's fields (its source is not part of the output; the shot keeps its own) */
  after: PolishedShotFields;
  changedKeys: (keyof ShotFields)[];
  /** Chinese names of changedKeys */
  changed: string[];
  changeNote: string;
  issues: DraftIssue[];
  errors: DraftIssue[];
  warnings: DraftIssue[];
  /** the shot was edited after the request: the server would answer 409 */
  stale: boolean;
  selectable: boolean;
  /** why the checkbox is disabled, for the tooltip */
  blockedReason: string | null;
}

export type PolishParse =
  | { ok: true; scope: PolishScopeView; items: PolishItem[]; draftIssues: DraftIssue[] }
  | { ok: false; scope: PolishScopeView; draftIssues: DraftIssue[] };

function blockedReasonOf(i: Pick<PolishItem, 'shot' | 'stale' | 'errors'>): string | null {
  if (!i.shot || i.shot.archived) return '这个镜头已不在镜头表里';
  if (i.shot.locked) return '镜头已锁定，不会被改动';
  if (i.stale) return '镜头在润色之后被改过，这一条不能应用；关掉草案重新润色';
  const err = i.errors[0];
  return err ? `有错误，不能应用：${err.message}` : null;
}

export function parsePolishDraft(detail: Pick<DraftDetail, 'draft' | 'current_shots'>): PolishParse {
  const { draft } = detail;
  const scope = readPolishScope(draft.scope);
  const draftIssues = draft.issues.filter((x) => x.item === null);
  const parsed = PolishOutput.safeParse(draft.parsed);
  if (!parsed.success) return { ok: false, scope, draftIssues: draft.issues };
  const byId = new Map(detail.current_shots.map((s) => [s.id, s] as const));
  const items = parsed.data.shots.map((out, index): PolishItem => {
    const shotId = scope.refs[out.ref];
    const shot = shotId ? (byId.get(shotId) ?? null) : null;
    const issues = draft.issues.filter((x) => x.item === index);
    const errors = issues.filter((x) => x.level === 'error');
    const warnings = issues.filter((x) => x.level === 'warning');
    const expected = shot ? scope.expected[shot.id] : undefined;
    const stale = shot !== null && expected !== undefined && shot.revision !== expected;
    // the shot keeps its own source: compare on the full fields so `source` never shows as changed
    const changedKeys = shot ? changedFieldKeys(shot.fields, { ...out.fields, source: shot.fields.source }) : [];
    const base = { shot, stale, errors };
    const blockedReason = blockedReasonOf(base);
    return {
      index,
      ref: out.ref,
      shot,
      before: shot ? shot.fields : null,
      after: out.fields,
      changedKeys,
      changed: changedKeys.map((k) => SHOT_FIELD_LABEL[k]),
      changeNote: out.change_note.trim(),
      issues,
      errors,
      warnings,
      stale,
      selectable: blockedReason === null,
      blockedReason,
    };
  });
  return { ok: true, scope, items, draftIssues };
}

/** Default ticks: every item that can be applied. */
export function defaultPolishSelection(items: readonly PolishItem[]): Set<number> {
  return new Set(items.filter((i) => i.selectable).map((i) => i.index));
}

/** Toggle one item; an item that cannot be applied is never added. */
export function togglePolishItem(selected: ReadonlySet<number>, item: Pick<PolishItem, 'index' | 'selectable'>): Set<number> {
  const next = new Set(selected);
  if (next.has(item.index)) next.delete(item.index);
  else if (item.selectable) next.add(item.index);
  return next;
}

/**
 * Body of POST /drafts/:id/apply-polish: the ticked items that can be applied
 * (ascending) and, for exactly those shots, the revision the draft was made
 * from — so an edit since then comes back as 409 instead of being overwritten.
 */
export function buildApplyPolishInput(args: {
  items: readonly Pick<PolishItem, 'index' | 'shot' | 'selectable'>[];
  selected: ReadonlySet<number>;
  /** draft.scope.expected_revisions */
  expected: Readonly<Record<string, number>>;
}): InputOf<'applyPolish'> {
  const chosen = args.items.filter((i) => i.selectable && args.selected.has(i.index)).sort((a, b) => a.index - b.index);
  const expected_revisions: Record<string, number> = {};
  for (const item of chosen) {
    const rev = item.shot ? args.expected[item.shot.id] : undefined;
    if (item.shot && rev !== undefined) expected_revisions[item.shot.id] = rev;
  }
  return { selected: chosen.map((i) => i.index), expected_revisions };
}

/** "已润色 2 个镜头，1 个锁定镜头未改动。" */
export function polishAppliedNotice(r: Pick<ApplyPolishResult, 'updated' | 'skipped_locked_ids' | 'skipped_missing_ids'>): string {
  const parts = [`已润色 ${r.updated.length} 个镜头`];
  if (r.skipped_locked_ids.length > 0) parts.push(`${r.skipped_locked_ids.length} 个锁定镜头未改动`);
  if (r.skipped_missing_ids.length > 0) parts.push(`${r.skipped_missing_ids.length} 个镜头已不在镜头表`);
  if (r.updated.length === 0 && parts.length === 1) parts.push('内容与原来相同');
  return `${parts.join('，')}。`;
}

// -------------------------------------------------------------- before/after --

export interface DiffLine {
  key: string;
  /** field name in front of the text; null for the shot's main lines */
  label: string | null;
  text: string;
  changed: boolean;
}

const SPEC_KEYS: readonly (keyof ShotFields)[] = ['shot_size', 'angle', 'lens', 'focal_mm', 'movement'];
/** keys shown as the main lines of a side; every other changed key becomes a labelled line */
const MAIN_KEYS: ReadonlySet<keyof ShotFields> = new Set<keyof ShotFields>([...SPEC_KEYS, 'action', 'camera_notes', 'source']);

const NONE = '无';

/** One field of a shot as display text (Chinese labels for the closed vocabularies). */
export function fieldText(key: keyof ShotFields, f: PolishedShotFields, aliasLabel: (alias: string) => string = (a) => a): string {
  switch (key) {
    case 'template':
      return f.template ? TEMPLATE_LABEL[f.template] : '自动推导';
    case 'subjects':
      return f.subjects.length === 0
        ? NONE
        : f.subjects
            .map((s) =>
              [aliasLabel(s.alias), s.screen ? SCREEN_POS_LABEL[s.screen] : null, s.depth ? DEPTH_LABEL[s.depth] : null, s.facing ? FACING_LABEL[s.facing] : null, s.pose ? POSE_LABEL[s.pose] : null]
                .filter(Boolean)
                .join(' '),
            )
            .join('；');
    case 'props':
      return f.props.length === 0 ? NONE : f.props.map((p) => PROP_LABEL[p]).join('、');
    case 'env':
      return f.env ? ENV_LABEL[f.env] : NONE;
    case 'subject_motion':
      return SUBJECT_MOTION_LABEL[f.subject_motion];
    case 'set_piece':
      return f.set_piece ? '是' : '否';
    case 'pov_owner':
      return f.pov_owner ? aliasLabel(f.pov_owner) : NONE;
    case 'frame_format':
      return f.frame_format ? FRAME_FORMAT_LABEL[f.frame_format] : '沿用项目画幅';
    case 'technique_id':
      return f.technique_id ? (TECHNIQUES.find((t) => t.id === f.technique_id)?.name ?? f.technique_id) : NONE;
    case 'est_seconds':
      return `${f.est_seconds} 秒`;
    case 'narrative_purpose':
      return f.narrative_purpose.trim() || '（空）';
    case 'action':
      return f.action.trim() || '（未填写动作）';
    case 'dialogue_quote':
      return f.dialogue_quote ? `「${f.dialogue_quote}」` : NONE;
    case 'camera_notes':
      return f.camera_notes?.trim() || NONE;
    case 'assumptions':
      return f.assumptions.length === 0 ? NONE : f.assumptions.join('；');
    case 'questions':
      return f.questions.length === 0 ? NONE : f.questions.join('；');
    case 'shot_size':
    case 'angle':
    case 'lens':
    case 'focal_mm':
    case 'movement':
      return shotSpecLine(f);
    default:
      return '';
  }
}

/**
 * The lines of one side (改前 or 改后): the spec line, the action and the
 * camera notes, then one labelled line for every other field that changed.
 * `changed` marks the lines the polish touched, so the two sides can be read
 * against each other.
 */
export function sideLines(f: PolishedShotFields, changedKeys: readonly (keyof ShotFields)[], aliasLabel?: (alias: string) => string): DiffLine[] {
  const changed = new Set(changedKeys);
  const lines: DiffLine[] = [
    { key: 'spec', label: null, text: shotSpecLine(f), changed: SPEC_KEYS.some((k) => changed.has(k)) },
    { key: 'action', label: null, text: fieldText('action', f), changed: changed.has('action') },
  ];
  const notes = f.camera_notes?.trim();
  if (notes || changed.has('camera_notes')) lines.push({ key: 'camera_notes', label: '拍法', text: notes || NONE, changed: changed.has('camera_notes') });
  for (const k of changedKeys) {
    if (MAIN_KEYS.has(k)) continue;
    lines.push({ key: k, label: SHOT_FIELD_LABEL[k], text: fieldText(k, f, aliasLabel), changed: true });
  }
  return lines;
}
