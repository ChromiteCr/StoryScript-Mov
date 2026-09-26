import type { Plan, Scene, Setup, Shot, Take } from '@storyscript/contracts';
import { formatSlate } from '@storyscript/core';

/**
 * Pure helpers of the set page (FR-07): shot labels, shooting order (approved
 * plan first, else narrative order), take numbering, slate preview and the
 * next in-camera clip name. No DOM, no React: unit-tested.
 */

export interface ShotRef {
  shot: Shot;
  /** "1" — the scene's display number, "?" when the scene is not in the current script */
  scene_no: string;
  scene_heading: string;
  /** "1-003" */
  label: string;
  /** sort key in narrative order */
  order: number;
}

export function shotLabel(sceneNo: string, code: string): string {
  return `${sceneNo}-${code}`;
}

/** Active shots with their scene, in narrative order (scene order, then narrative_pos). */
export function buildShotRefs(shots: readonly Shot[], scenes: readonly Pick<Scene, 'id' | 'display_no' | 'heading'>[]): ShotRef[] {
  const sceneIndex = new Map(scenes.map((s, i) => [s.id, { scene: s, i }] as const));
  return shots
    .filter((s) => !s.archived)
    .map((shot, idx) => {
      const sc = sceneIndex.get(shot.scene_id);
      const scene_no = sc?.scene.display_no ?? '?';
      return {
        shot,
        scene_no,
        scene_heading: sc?.scene.heading ?? '（不在当前剧本版本中）',
        label: shotLabel(scene_no, shot.code),
        order: (sc ? sc.i : scenes.length) * 1_000_000 + shot.narrative_pos * 1000 + idx / 1000,
      };
    })
    .sort((a, b) => a.order - b.order);
}

export interface OrderGroup {
  key: string;
  title: string;
  /** e.g. the scene heading or the setup's place in the plan */
  subtitle: string | null;
  refs: ShotRef[];
}

export interface ShootingOrder {
  source: 'plan' | 'narrative';
  plan: Plan | null;
  groups: OrderGroup[];
  /** flattened, in display order */
  refs: ShotRef[];
}

/** The approved plan to follow on set: today's in the plan's zone, else the latest approved one. */
export function pickApprovedPlan(plans: readonly Plan[], today: string | null = null): Plan | null {
  const approved = plans.filter((p) => p.status === 'approved');
  if (approved.length === 0) return null;
  const todays = today ? approved.filter((p) => p.date === today) : [];
  const pool = todays.length > 0 ? todays : approved;
  return [...pool].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))[0]!;
}

export function shootingOrder(refs: readonly ShotRef[], plans: readonly Plan[], setups: readonly Setup[], today: string | null = null): ShootingOrder {
  const plan = pickApprovedPlan(plans, today);
  if (plan) {
    const byId = new Map(refs.map((r) => [r.shot.id, r] as const));
    const setupById = new Map(setups.map((s) => [s.id, s] as const));
    const used = new Set<string>();
    const groups: OrderGroup[] = [];
    plan.result.order.forEach((setupId, i) => {
      const setup = setupById.get(setupId);
      if (!setup) return;
      const list = setup.shot_ids.map((id) => byId.get(id)).filter((r): r is ShotRef => r !== undefined && !used.has(r.shot.id));
      for (const r of list) used.add(r.shot.id);
      if (list.length > 0) groups.push({ key: setup.id, title: setup.label || `机位组 ${i + 1}`, subtitle: `第 ${i + 1} 组`, refs: list });
    });
    const rest = refs.filter((r) => !used.has(r.shot.id));
    if (rest.length > 0) groups.push({ key: 'unplanned', title: '计划外', subtitle: '不在已批准计划里的镜头', refs: rest });
    return { source: 'plan', plan, groups, refs: groups.flatMap((g) => g.refs) };
  }
  const groups: OrderGroup[] = [];
  for (const r of refs) {
    const last = groups[groups.length - 1];
    const key = `scene-${r.shot.scene_id}`;
    if (last && last.key === key) last.refs.push(r);
    else groups.push({ key, title: `第 ${r.scene_no} 场`, subtitle: r.scene_heading, refs: [r] });
  }
  return { source: 'narrative', plan: null, groups, refs: [...refs] };
}

/** Setup of a shot in the followed plan (for Take.setup_id). */
export function setupOfShot(setups: readonly Setup[], shotId: string): string | null {
  return setups.find((s) => s.shot_ids.includes(shotId))?.id ?? null;
}

const setKey = (ids: readonly string[]) => [...new Set(ids)].sort().join('|');

/** Same rule as the server: next number for exactly this set of shots. */
export function nextTakeNo(takes: readonly Pick<Take, 'shot_ids' | 'take_no'>[], shotIds: readonly string[]): number {
  const key = setKey(shotIds);
  let max = 0;
  for (const t of takes) if (setKey(t.shot_ids) === key) max = Math.max(max, t.take_no);
  return max + 1;
}

/** Takes that include the shot, newest take number first. */
export function takesForShot<T extends Pick<Take, 'shot_ids' | 'take_no' | 'logged_at'>>(takes: readonly T[], shotId: string): T[] {
  return takes
    .filter((t) => t.shot_ids.includes(shotId))
    .sort((a, b) => b.take_no - a.take_no || (a.logged_at < b.logged_at ? 1 : -1));
}

/** "003" → 3; anything that is not a plain number → null. */
export function plainNumber(text: string): number | null {
  const m = /^\s*(\d{1,6})\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Slate code for the board, e.g. "S01-003-T02"; null when scene or shot are not plain numbers. */
export function slateCode(format: string, sceneNo: string, shotCode: string, takeNo: number): string | null {
  const scene = plainNumber(sceneNo);
  const shot = plainNumber(shotCode);
  if (scene === null || shot === null) return null;
  try {
    return formatSlate(format, { scene, shot, take: takeNo });
  } catch {
    return null;
  }
}

/**
 * The camera's next clip name: last digit run + 1, zero padding kept
 * ("A001C003" → "A001C004", "IMG_0999" → "IMG_1000"). Null when there is no number.
 */
export function nextClipHint(hint: string | null): string | null {
  const t = hint?.trim() ?? '';
  // a written file extension (".MP4") is kept as is, never counted
  const ext = /\.[a-z][a-z0-9]{0,4}$/i.exec(t)?.[0] ?? '';
  const stem = t.slice(0, t.length - ext.length);
  const m = /^(.*?)(\d+)(\D*)$/.exec(stem);
  if (!m) return null;
  const [, head, digits, tail] = m as unknown as [string, string, string, string];
  const next = String(Number(digits) + 1).padStart(digits.length, '0');
  return `${head}${next}${tail}${ext}`;
}

/** "3A-2, 十二 ,, x" → ["3A-2", "十二", "x"] (comma, 、 or ；). */
export function parseLabels(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,，、;；]/)) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** "14:05" in the viewer's zone. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
