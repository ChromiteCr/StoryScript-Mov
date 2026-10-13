import { TIP_SHOTS_MAX, type HealthInfo, type ShotDifficulty, type ShotGear, type ShotTip, type ShotTipsView } from '@storyscript/contracts';
import { planShotRef, ZH_SHOT_DIFFICULTY, ZH_SHOT_GEAR, type PlanLookup } from '@storyscript/core';
import { formatCommentTime } from './comments.ts';
import { actorShortText } from './crew.ts';
import { MAX_ATTEMPTS } from './jobs.ts';

/**
 * S5c 镜头拍摄提示 on the page: labels, where a tip comes from, when it is out
 * of date, the confirmation before the per-scene job, and the appendix the
 * call sheet prints. Pure, no DOM. Tips are hints only: nothing here changes
 * a shot.
 */

export const DIFFICULTY_LABEL: Readonly<Record<ShotDifficulty, string>> = ZH_SHOT_DIFFICULTY;
export const GEAR_LABEL: Readonly<Record<ShotGear, string>> = ZH_SHOT_GEAR;

/** 「难度：中」, also the title of the shot list's 难 badge */
export function difficultyText(d: ShotDifficulty): string {
  return `难度：${DIFFICULTY_LABEL[d]}`;
}

/** Gear names in the order given: ['三脚架', '外接麦']. */
export function gearLabels(gear: readonly ShotGear[]): string[] {
  return gear.map((g) => GEAR_LABEL[g]);
}

/** One tip per live shot, by shot id. */
export function tipsByShot(view: Pick<ShotTipsView, 'tips'> | null | undefined): Map<string, ShotTip> {
  return new Map((view?.tips ?? []).map((t) => [t.shot_id, t] as const));
}

/** Shots the shot list marks 难 (only the hard ones: the badge stays out of the way). */
export function hardShotIds(view: Pick<ShotTipsView, 'tips'> | null | undefined): Set<string> {
  return new Set((view?.tips ?? []).filter((t) => t.difficulty === 'hard').map((t) => t.shot_id));
}

// ------------------------------------------------------------------ source ---

export const RULE_SOURCE_TEXT = '按镜头字段估计';

/**
 * 「AI · 阿杰 10:32」 (the day too when it is not today), 「AI · 10:32」 on the
 * local app (no actor), or 「按镜头字段估计」 for the first guess. `now` and
 * `timeZone` are for tests.
 */
export function tipSourceText(tip: Pick<ShotTip, 'source' | 'actor' | 'created_at'>, now: Date = new Date(), timeZone?: string): string {
  if (tip.source === 'rule') return RULE_SOURCE_TEXT;
  const who = tip.actor ? actorShortText(tip.actor) : null;
  const when = tip.created_at ? formatCommentTime(tip.created_at, now, timeZone) : '';
  const rest = [who, when].filter((s) => s).join(' ');
  return rest ? `AI · ${rest}` : 'AI';
}

// ------------------------------------------------------------------- stale ---

export const TIPS_STALE_TEXT = '镜头改过，提示可能过时';
export const TIPS_START_LABEL = 'AI 生成本场拍摄提示';
export const TIPS_REGENERATE_LABEL = '重新生成本场';

/** The model's tips, written before the shot was changed (a first guess is never stale: it is worked out on every read). */
export function isStaleTip(tip: Pick<ShotTip, 'source' | 'stale'> | null | undefined): boolean {
  return tip?.source === 'ai' && tip.stale;
}

/** The group's one action: regenerate the scene under the stale notice, else generate. */
export function tipsAction(tip: Pick<ShotTip, 'source' | 'stale'> | null | undefined): { stale: boolean; label: string } {
  const stale = isStaleTip(tip);
  return { stale, label: stale ? TIPS_REGENERATE_LABEL : TIPS_START_LABEL };
}

/** Whether some shot of the scene already has the model's tips (they would be replaced). */
export function sceneHasAiTips(shotIds: readonly string[], tips: ReadonlyMap<string, Pick<ShotTip, 'source'>>): boolean {
  return shotIds.some((id) => tips.get(id)?.source === 'ai');
}

type AiGateLike = { enabled: boolean; reason: string | null };

/** Why the scene's tips cannot be asked for now; null when they can. */
export function tipsBlockedReason(a: { ai: AiGateLike; shots: number; running: boolean }): string | null {
  if (!a.ai.enabled) return a.ai.reason ?? 'AI 暂时不可用';
  if (a.running) return '本场的拍摄提示正在生成';
  if (a.shots === 0) return '这一场还没有镜头';
  if (a.shots > TIP_SHOTS_MAX) return `这一场的镜头超过 ${TIP_SHOTS_MAX} 个，暂不支持一次生成`;
  return null;
}

/**
 * After the job: 「第 1 场的拍摄提示已生成；2 个镜头没有拿到可用的提示，已略去……」
 * when some shots of the scene got nothing from this job (the model's items
 * for them were unusable, so they keep their earlier tips or the first
 * guess); null when every shot got new tips. A tip is this job's when the
 * model wrote it after the job was created.
 */
export function tipsDoneNotice(
  sceneNo: string,
  shotIds: readonly string[],
  tips: ReadonlyMap<string, Pick<ShotTip, 'source' | 'created_at'>>,
  since: string,
): string | null {
  const fresh = (t: Pick<ShotTip, 'source' | 'created_at'> | undefined) => t?.source === 'ai' && t.created_at !== null && Date.parse(t.created_at) >= Date.parse(since);
  const missing = shotIds.filter((id) => !fresh(tips.get(id))).length;
  if (missing === 0) return null;
  return `第 ${sceneNo} 场的拍摄提示已生成；${missing} 个镜头没有拿到可用的提示，已略去（保留原来的提示或按镜头字段估计）。`;
}

// ----------------------------------------------------------------- confirm ---

/** Whose key a remote job uses: the local app (no cap), the group's (counts against its daily cap) or the member's own. */
export type KeySource = 'local' | 'group' | 'own';

export function keySource(health: Pick<HealthInfo, 'hosted'> & Partial<Pick<HealthInfo, 'text_model_source'>> | null | undefined): KeySource {
  if (!health?.hosted) return 'local';
  return health.text_model_source === 'own' ? 'own' : 'group';
}

export interface TipsConfirmInput {
  demo: boolean;
  /** the model service's host (ws.providerHost); null when unknown */
  host: string | null;
  sceneNo: string;
  /** live shots of the scene */
  shots: number;
  key: KeySource;
  /** some shot of the scene has the model's tips already */
  again: boolean;
  /** the open shot has unsaved edits (the tips use the saved shot) */
  unsaved: boolean;
}

export function tipsConfirmTitle(again: boolean): string {
  return again ? '重新生成本场拍摄提示' : TIPS_START_LABEL;
}

/** What the confirmation says, line by line: where it goes, how much, how often, whose cap. */
export function tipsConfirmLines(a: TipsConfirmInput): string[] {
  const lines: string[] = [];
  if (a.demo) {
    lines.push(`演示模式：回放录好的示例（第 ${a.sceneNo} 场，本场 ${a.shots} 个镜头），不外发，也不计入用量。`);
  } else {
    lines.push(
      `会把第 ${a.sceneNo} 场的标题和本场 ${a.shots} 个镜头（镜号、景别、运动、人物、动作摘要和拍法说明）发送到 ${a.host ?? '你配置的地址'}，请模型给出每个镜头的难度、器材、实拍提示和常见失误。`,
    );
    lines.push(`1 次调用；输出格式不对时最多再试 ${MAX_ATTEMPTS - 1} 次（每步最多外发 ${MAX_ATTEMPTS} 次）。`);
    if (a.key === 'group') lines.push('用的是本组的 key，计入本组的每日上限（这次算 1 次）。');
    if (a.key === 'own') lines.push('用的是你自己的 key，不计入本组的每日上限。');
  }
  if (a.unsaved) lines.push('这个镜头有未保存的修改；提示按已保存的内容生成。');
  lines.push(a.again ? '新提示会替换本场现有的 AI 提示；提示只作参考，不会改动镜头。' : '提示只作参考，不会改动镜头。');
  return lines;
}

// ---------------------------------------------------------------- appendix ---

export interface TipsAppendixRow {
  shot_id: string;
  /** 「1-003」, as the call sheet's 镜头 column writes it */
  ref: string;
  difficulty: string;
  /** 「三脚架、外接麦」, '—' without gear */
  gear: string;
  tips: string[];
  mistake: string;
  stale: boolean;
}

export interface TipsAppendix {
  rows: TipsAppendixRow[];
  /** shots of the plan with only the first guess (no model tips): left out */
  without: number;
}

/**
 * The call sheet's 拍摄提示 appendix: the plan's shots in the order the call
 * sheet shoots them (`order`: shotsInShootingOrder), each with the model's
 * tips. Shots with only the first guess are left out and counted; shots no
 * longer in the project are skipped.
 */
export function tipsAppendix(order: readonly string[], lookup: PlanLookup, tips: ReadonlyMap<string, ShotTip>): TipsAppendix {
  const rows: TipsAppendixRow[] = [];
  let without = 0;
  for (const id of order) {
    if (!lookup.shots.has(id)) continue;
    const t = tips.get(id);
    if (!t || t.source !== 'ai' || t.tips.length === 0) {
      without++;
      continue;
    }
    rows.push({
      shot_id: id,
      ref: planShotRef(lookup, id),
      difficulty: DIFFICULTY_LABEL[t.difficulty],
      gear: gearLabels(t.gear).join('、') || '—',
      tips: t.tips,
      mistake: t.mistake ?? '',
      stale: t.stale,
    });
  }
  return { rows, without };
}
