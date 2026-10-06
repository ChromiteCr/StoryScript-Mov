import type { DraftIssue, ShotFields, ShotSize } from '@storyscript/contracts';
import { ZH_CAMERA_ANGLE, ZH_MOVEMENT, ZH_SHOT_SIZE } from '../i18n/zh.ts';

/**
 * S4c 镜头变化检查: a deterministic look at a run of shots in narrative order
 * (one scene's breakdown, or the shots picked for 丰富变化) for the monotony a
 * model falls into — eye-level static close shots in a row, nobody moving,
 * everyone in the middle of the frame. Only warnings: a quiet scene may be
 * monotone on purpose. `severe` decides whether a breakdown gets one more
 * model round (server ai/jobs.ts); `score` (0–1, higher is more varied)
 * decides whether that round's answer is kept.
 */

export type VarietyShot = Pick<ShotFields, 'shot_size' | 'angle' | 'movement' | 'subjects' | 'subject_motion' | 'action'>;

export type VarietyCode =
  | 'VARIETY_SIZE_RUN'
  | 'VARIETY_SIZE_DOMINANT'
  | 'VARIETY_FEW_SIZES'
  | 'VARIETY_NO_WIDE'
  | 'VARIETY_ALL_EYE'
  | 'VARIETY_MOSTLY_STATIC'
  | 'VARIETY_ALL_CENTER'
  | 'VARIETY_MOTION_UNSET';

/** Thresholds; a rule applies only from its `min_shots`. */
export const VARIETY_RULES = {
  /** this many consecutive shots with the same size, angle and movement */
  run: 3,
  dominant: { min_shots: 5, share: 0.6 },
  few_sizes: { min_shots: 4, sizes: 3 },
  no_wide: { min_shots: 4 },
  all_eye: { min_shots: 6 },
  mostly_static: { min_shots: 4, share: 0.7 },
  /** shots with people in them */
  all_center: { min_people_shots: 3 },
} as const;

/**
 * severe (another model round is worth it), from `min_shots` shots on:
 *   1. a run of `run` or more identical framings (size, angle, movement), or
 *   2. `codes` or more different framing codes (SIZE_RUN, SIZE_DOMINANT,
 *      FEW_SIZES, NO_WIDE, ALL_EYE, MOSTLY_STATIC).
 * ALL_CENTER and MOTION_UNSET never count: layout places people on thirds
 * anyway, and a missed motion is one field to fix by hand.
 */
export const VARIETY_SEVERE = { min_shots: 4, run: 4, codes: 2 } as const;

const FRAMING_CODES: readonly VarietyCode[] = [
  'VARIETY_SIZE_RUN',
  'VARIETY_SIZE_DOMINANT',
  'VARIETY_FEW_SIZES',
  'VARIETY_NO_WIDE',
  'VARIETY_ALL_EYE',
  'VARIETY_MOSTLY_STATIC',
];

const WIDE: ReadonlySet<ShotSize> = new Set(['EWS', 'WS', 'FS', 'MLS']);

/**
 * Words in an action that mean someone moves through the frame. Compounds for
 * 进/出 (进来, 出门 …) and look-arounds keep 走廊, 追问 out; 冲 counts only as a
 * dash somewhere (冲出, 冲向 …), not as 冲着 / 冲他 / 冲突; 走 not as the result
 * of taking or carrying something away (拿走, 带走, 吹走).
 */
const MOTION_WORDS = /(?<![拿带抢偷收吹搬取夺赶])走(?![廊道神])|跑|追(?![问究])|冲(?=[出进向上过回入下])|奔|进来|进去|进门|进屋|进入|出去|出门|离开|转身/;

export interface VarietyStats {
  shots: number;
  sizes: Partial<Record<ShotSize, number>>;
  distinct_sizes: number;
  dominant_size: ShotSize | null;
  /** share of the most used size, 0–1 */
  dominant_share: number;
  eye_share: number;
  static_share: number;
  /** longest run of consecutive shots with the same size, angle and movement */
  longest_run: number;
  has_wide: boolean;
  /** shots with at least one person */
  people_shots: number;
  /** of those, shots with someone placed left or right */
  off_center_shots: number;
  /** shots whose action moves but whose people stand still (MOTION_UNSET) */
  motion_unset: number;
}

export interface VarietyReport {
  stats: VarietyStats;
  /** DraftIssue warnings, codes VARIETY_*; per-shot ones carry the shot index */
  issues: DraftIssue[];
  /** 0–1, higher is more varied; two decimals */
  score: number;
  severe: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const warn = (code: VarietyCode, message: string, item: number | null = null): DraftIssue => ({ level: 'warning', code, message, item });

const framingKey = (s: VarietyShot) => `${s.shot_size}|${s.angle}|${s.movement}`;

/** The motion word in an action whose people all stand still, or null. */
function unsetMotion(s: VarietyShot): string | null {
  if (s.subjects.length === 0 || s.subject_motion !== 'none') return null;
  if (!s.subjects.every((p) => p.pose === null || p.pose === 'stand')) return null;
  return MOTION_WORDS.exec(s.action)?.[0] ?? null;
}

export function analyzeVariety(shots: readonly VarietyShot[]): VarietyReport {
  const n = shots.length;
  const sizes: Partial<Record<ShotSize, number>> = {};
  for (const s of shots) sizes[s.shot_size] = (sizes[s.shot_size] ?? 0) + 1;
  let dominant: ShotSize | null = null;
  for (const [size, count] of Object.entries(sizes) as [ShotSize, number][]) {
    if (dominant === null || count > sizes[dominant]!) dominant = size;
  }
  const share = (pred: (s: VarietyShot) => boolean) => (n ? shots.filter(pred).length / n : 0);

  // runs of identical framing: [start, end] inclusive, length ≥ VARIETY_RULES.run
  const runs: [number, number][] = [];
  let longest = n ? 1 : 0;
  for (let start = 0; start < n; ) {
    let end = start;
    while (end + 1 < n && framingKey(shots[end + 1]!) === framingKey(shots[start]!)) end++;
    longest = Math.max(longest, end - start + 1);
    if (end - start + 1 >= VARIETY_RULES.run) runs.push([start, end]);
    start = end + 1;
  }

  const people = shots.filter((s) => s.subjects.length > 0);
  const offCenter = people.filter((s) => s.subjects.some((p) => p.screen === 'L' || p.screen === 'R'));
  const unset = shots.map(unsetMotion);

  const stats: VarietyStats = {
    shots: n,
    sizes,
    distinct_sizes: Object.keys(sizes).length,
    dominant_size: dominant,
    dominant_share: dominant ? sizes[dominant]! / n : 0,
    eye_share: share((s) => s.angle === 'eye'),
    static_share: share((s) => s.movement === 'static'),
    longest_run: longest,
    has_wide: shots.some((s) => WIDE.has(s.shot_size)),
    people_shots: people.length,
    off_center_shots: offCenter.length,
    motion_unset: unset.filter((w) => w !== null).length,
  };

  const issues: DraftIssue[] = [];
  for (const [a, b] of runs) {
    const s = shots[a]!;
    issues.push(
      warn(
        'VARIETY_SIZE_RUN',
        `第 ${a + 1}–${b + 1} 个镜头都是${ZH_SHOT_SIZE[s.shot_size]}、${ZH_CAMERA_ANGLE[s.angle]}、${ZH_MOVEMENT[s.movement]}：中间换一个景别或角度，或者让机位动起来`,
        a,
      ),
    );
  }
  if (n >= VARIETY_RULES.dominant.min_shots && dominant && stats.dominant_share > VARIETY_RULES.dominant.share) {
    issues.push(
      warn(
        'VARIETY_SIZE_DOMINANT',
        `${n} 个镜头里有 ${sizes[dominant]} 个${ZH_SHOT_SIZE[dominant]}（${pct(stats.dominant_share)}）：对话可以在中景和近景之间交替，情绪高点再给特写`,
      ),
    );
  }
  if (n >= VARIETY_RULES.few_sizes.min_shots && stats.distinct_sizes < VARIETY_RULES.few_sizes.sizes) {
    const used = (Object.keys(sizes) as ShotSize[]).map((s) => ZH_SHOT_SIZE[s]).join('、');
    issues.push(
      warn('VARIETY_FEW_SIZES', `景别只有${used}：加一个交代空间的远景或全景，关键反应给特写，物件给插入镜头`),
    );
  }
  if (n >= VARIETY_RULES.no_wide.min_shots && !stats.has_wide) {
    issues.push(warn('VARIETY_NO_WIDE', '没有远景、全景或中全景：观众看不出人物在哪儿，开场或换位置时加一个交代空间的镜头'));
  }
  if (n >= VARIETY_RULES.all_eye.min_shots && stats.eye_share === 1) {
    issues.push(warn('VARIETY_ALL_EYE', `${n} 个镜头全是平视：在有理由的地方换角度，比如仰拍表现压迫，俯拍表现孤立`));
  }
  if (n >= VARIETY_RULES.mostly_static.min_shots && stats.static_share > VARIETY_RULES.mostly_static.share) {
    const k = shots.filter((s) => s.movement === 'static').length;
    issues.push(warn('VARIETY_MOSTLY_STATIC', `${n} 个镜头里有 ${k} 个固定机位：人物走动时跟拍或摇，紧张升级时慢慢推近`));
  }
  if (people.length >= VARIETY_RULES.all_center.min_people_shots && offCenter.length === 0) {
    issues.push(warn('VARIETY_ALL_CENTER', '有人物的镜头都把人放在画面正中或没填位置：单人镜头放到画左或画右的三分线上，视线一侧留空'));
  }
  unset.forEach((word, i) => {
    if (word) {
      issues.push(warn('VARIETY_MOTION_UNSET', `动作里有「${word}」，但人物站着、也没有人物运动：把姿势改成走或跑，或填写人物运动方向`, i));
    }
  });

  // score: weighted parts, each 0–1
  const simpson = n ? 1 - Object.values(sizes).reduce((acc, c) => acc + (c! / n) ** 2, 0) : 1;
  const parts = {
    sizes: n ? clamp01(simpson / 0.75) : 1,
    angles: n ? clamp01((1 - stats.eye_share) / 0.25) : 1,
    movement: n ? clamp01((1 - stats.static_share) / 0.35) : 1,
    runs: longest <= 2 ? 1 : clamp01(1 - (longest - 2) / 3),
    placement: people.length ? clamp01(offCenter.length / people.length / 0.5) : 1,
    motion: n ? 1 - stats.motion_unset / n : 1,
  };
  const score = round2(
    parts.sizes * 0.3 + parts.angles * 0.15 + parts.movement * 0.2 + parts.runs * 0.15 + parts.placement * 0.1 + parts.motion * 0.1,
  );

  const framingCodes = new Set(issues.map((x) => x.code).filter((c) => FRAMING_CODES.includes(c as VarietyCode)));
  const severe = n >= VARIETY_SEVERE.min_shots && (longest >= VARIETY_SEVERE.run || framingCodes.size >= VARIETY_SEVERE.codes);

  return { stats, issues, score, severe };
}

/** The report as hints for one more model round (shot numbers are 1-based). */
export function varietyHints(report: VarietyReport): string[] {
  return report.issues.map((x) => (x.item !== null && x.code === 'VARIETY_MOTION_UNSET' ? `第 ${x.item + 1} 个镜头：${x.message}` : x.message));
}
