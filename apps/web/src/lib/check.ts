import type { Scene, SceneIntExt, ScriptEstimate, ScriptRisk, ScriptRiskCategory, ScriptRiskSeverity } from '@storyscript/contracts';

/**
 * S5 剧本体检 on the script page: labels, the m:ss times of the estimate, and
 * the checklist grouped by scene (stale items apart). Pure, no DOM.
 */

export const RISK_CATEGORY_LABEL: Record<ScriptRiskCategory, string> = {
  night_exterior: '夜外景',
  rain_water: '雨水',
  vehicle: '车辆',
  crowd: '人群',
  animal: '动物',
  stunt: '危险动作',
  permit_location: '需审批场地',
  vfx: '特效',
  period: '年代服化',
};

export const RISK_SEVERITY_LABEL: Record<ScriptRiskSeverity, string> = { low: '留意', medium: '较难', high: '很难' };

/** What each level means, for the title of its badge. */
export const RISK_SEVERITY_HINT: Record<ScriptRiskSeverity, string> = {
  low: '留意一下就能拍',
  medium: '需要专门准备',
  high: '按原样学生很难拍成',
};

export const INT_EXT_LABEL: Record<SceneIntExt, string> = { int: '内', ext: '外', int_ext: '内外' };

/** 108 → "1:48"; 3725 → "1:02:05" */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** 145 → "2 分 25 秒"; 40 → "40 秒" */
export function spoken(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec} 秒`;
  return sec === 0 ? `${m} 分钟` : `${m} 分 ${sec} 秒`;
}

/** 「目标 2 分钟，超出约 21%」, 「目标 5 分钟，还差约 30%」, or null without a target or when within 5%. */
export function targetNote(est: Pick<ScriptEstimate, 'seconds' | 'target_seconds'>): { text: string; over: boolean } | null {
  const target = est.target_seconds;
  if (!target || est.seconds === 0) return null;
  const ratio = est.seconds / target - 1;
  const pct = Math.round(Math.abs(ratio) * 100);
  if (pct < 5) return { text: `目标 ${spoken(target)}，基本吻合`, over: false };
  return ratio > 0 ? { text: `目标 ${spoken(target)}，超出约 ${pct}%`, over: true } : { text: `目标 ${spoken(target)}，比目标短约 ${pct}%`, over: false };
}

export interface RiskGroup {
  scene: Pick<Scene, 'id' | 'display_no' | 'heading'> | null;
  risks: ScriptRisk[];
}

export interface RiskList {
  /** by scene in script order; a group with scene null holds items outside any scene */
  groups: RiskGroup[];
  /** the script changed and these quotes are gone */
  stale: ScriptRisk[];
  counts: { total: number; open: number; high: number; handled: number; stale: number };
}

/** The checklist: current items by scene, the handled ones hidden on request; stale items apart. */
export function riskList(risks: readonly ScriptRisk[], scenes: readonly Pick<Scene, 'id' | 'display_no' | 'heading'>[], hideHandled: boolean): RiskList {
  const live = risks.filter((r) => !r.stale);
  const stale = risks.filter((r) => r.stale);
  const counts = {
    total: live.length,
    open: live.filter((r) => !r.handled).length,
    high: live.filter((r) => !r.handled && r.severity === 'high').length,
    handled: live.filter((r) => r.handled).length,
    stale: stale.length,
  };
  const shown = hideHandled ? live.filter((r) => !r.handled) : live;
  const groups: RiskGroup[] = [];
  for (const scene of scenes) {
    const list = shown.filter((r) => r.scene_id === scene.id);
    if (list.length) groups.push({ scene, risks: list });
  }
  const known = new Set(scenes.map((s) => s.id));
  const outside = shown.filter((r) => !r.scene_id || !known.has(r.scene_id));
  if (outside.length) groups.push({ scene: null, risks: outside });
  return { groups, stale, counts };
}

/** 「12 条 · 未处理 8 · 很难 2」 */
export function countsLine(c: RiskList['counts']): string {
  const parts = [`${c.total} 条`, `未处理 ${c.open}`];
  if (c.high > 0) parts.push(`很难 ${c.high}`);
  return parts.join(' · ');
}

/** Characters of the script text sent with a check (headings included, the title block not). */
export function scriptChars(paragraphs: readonly { text: string; scene_idx: number | null }[]): number {
  return paragraphs.filter((p) => p.scene_idx !== null).reduce((n, p) => n + Array.from(p.text.replace(/\s/g, '')).length, 0);
}
