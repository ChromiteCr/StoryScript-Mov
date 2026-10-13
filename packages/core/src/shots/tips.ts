import { TIP_TEXT_MAX, TIPS_MAX, TIPS_MIN, type Movement, type ShotDifficulty, type ShotFields, type ShotGear, type ShotTipsOutput, type TimeOfDay } from '@storyscript/contracts';
import { flagFilmClaims } from '../prompt/claims.ts';

/**
 * S5c 镜头拍摄提示, without and with a model.
 *
 * ruleTips reads a first guess at a shot's difficulty and gear off its fields
 * (no model). A model's answer for a scene is normalised, checked (one item
 * per shot, 2–3 short tips, one common mistake, gear from the list, no film
 * claims) and finalised: usable items kept, long texts cut, the rest dropped.
 */

export interface RuleTip {
  difficulty: ShotDifficulty;
  gear: ShotGear[];
}

const STEADY: ReadonlySet<Movement> = new Set<Movement>(['track', 'handheld', 'orbit', 'crane']);
const RAILS: ReadonlySet<Movement> = new Set<Movement>(['push_in', 'pull_out', 'dolly_zoom']);
const HARD_MOVES: ReadonlySet<Movement> = new Set<Movement>(['aerial', 'vehicle', 'dolly_zoom', 'orbit', 'crane']);
const MEDIUM_MOVES: ReadonlySet<Movement> = new Set<Movement>(['track', 'handheld', 'push_in', 'pull_out', 'pan', 'tilt']);
const FACE_SIZES = new Set(['CU', 'MCU', 'ECU']);

/** A first guess from the shot's fields (S5c §3): what it asks of the crew and what to bring. */
export function ruleTips(f: Pick<ShotFields, 'movement' | 'dialogue_quote' | 'subjects' | 'shot_size' | 'set_piece' | 'subject_motion'>, time: TimeOfDay = 'day'): RuleTip {
  const gear: ShotGear[] = [];
  const add = (g: ShotGear) => {
    if (!gear.includes(g)) gear.push(g);
  };
  const people = f.subjects.length;
  const talk = !!f.dialogue_quote?.trim();
  if (f.movement === 'static') add('tripod');
  if (STEADY.has(f.movement)) add('gimbal');
  if (RAILS.has(f.movement)) add('slider');
  if (f.movement === 'aerial') add('drone');
  if (f.movement === 'vehicle') add('car_mount');
  if (talk) add('external_mic');
  if (talk && people >= 2) add('boom');
  if (time === 'night') add('light');
  if (time !== 'night' && FACE_SIZES.has(f.shot_size) && people > 0) add('reflector');
  if (f.shot_size === 'INSERT' || f.shot_size === 'ECU') add('phone_lens');
  const difficulty: ShotDifficulty =
    f.set_piece || HARD_MOVES.has(f.movement) || people >= 4
      ? 'hard'
      : MEDIUM_MOVES.has(f.movement) || f.subject_motion !== 'none' || time === 'night' || (talk && people >= 2)
        ? 'medium'
        : 'easy';
  return { difficulty, gear };
}

// ------------------------------------------------------------ normalise ----

const key = (v: string) => v.normalize('NFKC').trim().toLowerCase().replace(/[\s\-]+/g, '_');

const DIFFICULTY_WORDS: Record<string, ShotDifficulty> = {
  easy: 'easy',
  low: 'easy',
  simple: 'easy',
  易: 'easy',
  简单: 'easy',
  容易: 'easy',
  低: 'easy',
  medium: 'medium',
  mid: 'medium',
  moderate: 'medium',
  normal: 'medium',
  中: 'medium',
  中等: 'medium',
  一般: 'medium',
  hard: 'hard',
  high: 'hard',
  difficult: 'hard',
  难: 'hard',
  困难: 'hard',
  较难: 'hard',
  高: 'hard',
};

const GEAR_WORDS: Record<ShotGear, readonly string[]> = {
  tripod: ['tripod', '三脚架', '脚架', '三角架', '手机支架'],
  gimbal: ['gimbal', 'stabilizer', 'steadicam', '稳定器', '手持稳定器', '云台'],
  slider: ['slider', 'dolly', 'rail', 'track', '滑轨', '轨道', '小滑轨'],
  external_mic: ['external_mic', 'mic', 'microphone', 'lavalier', 'lav', 'shotgun_mic', '外接麦', '麦克风', '领夹麦', '小蜜蜂', '枪麦', '收音麦'],
  boom: ['boom', 'boom_pole', '收音杆', '挑杆', '吊杆'],
  light: ['light', 'led', 'fill_light', 'lamp', '补光灯', '补光', '灯', '灯光', 'led灯'],
  reflector: ['reflector', 'bounce', '反光板', '反光'],
  phone_lens: ['phone_lens', 'clip_lens', 'lens', 'macro_lens', 'wide_lens', '外接镜头', '手机镜头', '手机外接镜头', '微距镜头', '广角镜头', '长焦镜头'],
  drone: ['drone', 'uav', '无人机', '航拍器'],
  car_mount: ['car_mount', 'suction_mount', '车载支架', '吸盘支架', '车载'],
};
const GEAR_OF = new Map<string, ShotGear>(Object.entries(GEAR_WORDS).flatMap(([g, words]) => words.map((w) => [key(w), g as ShotGear] as const)));

const asText = (v: unknown): unknown => (v == null ? '' : typeof v === 'string' ? v.trim() : v);
const asList = (v: unknown): unknown => {
  if (v == null) return [];
  // a list marker is a number followed by . 、 ) — not the 1 of 「1.5 米」
  if (typeof v === 'string') return v.split(/[\n；;]+/).map((s) => s.replace(/^\s*(?:\d+[.、)）](?!\d)|[-•·])\s*/, '').trim()).filter(Boolean);
  return v;
};

function normRef(v: unknown): unknown {
  if (typeof v === 'number' && Number.isInteger(v)) return `s${v}`;
  if (typeof v !== 'string') return v;
  const m = /^[#\s]*s?\s*(\d+)\s*$/i.exec(v.trim());
  return m ? `s${Number(m[1])}` : v.trim();
}

/** Gear words mapped to the list; anything off the list is left out (gear may be empty), so one odd word does not sink the scene's answer. */
function normGear(v: unknown): unknown {
  const list = typeof v === 'string' ? v.split(/[,，、;；\s]+/).filter(Boolean) : v == null ? [] : v;
  if (!Array.isArray(list)) return list;
  return list.flatMap((g) => {
    const m = typeof g === 'string' ? GEAR_OF.get(key(g)) : undefined;
    return m ? [m] : [];
  });
}

function normDifficulty(d: unknown): ShotDifficulty | null {
  if (typeof d !== 'string') return null;
  return DIFFICULTY_WORDS[key(d)] ?? DIFFICULTY_WORDS[d.trim()] ?? null;
}

/**
 * Lenient pre-normalisation before zod: shapes, Chinese words for the enums, a
 * string where a list belongs. An item whose difficulty is not one of the
 * three is left out here (validation then asks for that shot again), so the
 * other items of the answer stay usable.
 */
export function normalizeShotTipsJson(raw: unknown): unknown {
  let list: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    list = o.shots ?? o.items ?? o.tips;
  }
  if (!Array.isArray(list)) return raw;
  return {
    shots: list.flatMap((item) => {
      if (!item || typeof item !== 'object') return [item];
      const it = item as Record<string, unknown>;
      const difficulty = normDifficulty(it.difficulty ?? it.level);
      if (!difficulty) return [];
      const mistake = it.mistake ?? it.common_mistake ?? it.pitfall;
      return [
        {
          ref: normRef(it.ref ?? it.shot ?? it.id),
          difficulty,
          gear: normGear(it.gear ?? it.equipment),
          tips: asList(it.tips ?? it.advice),
          mistake: Array.isArray(mistake) ? asText(mistake[0]) : asText(mistake),
        },
      ];
    }),
  };
}

// ------------------------------------------------------------- validate ----

const len = (s: string) => Array.from(s).length;
const cut = (s: string, max: number) => (len(s) <= max ? s : `${Array.from(s).slice(0, max - 1).join('')}…`);
const claims = (s: string) => flagFilmClaims(s).length > 0;

/** Repair messages for a scene's answer; empty when it is usable as it is. `refs` are the scene's shots in prompt order. */
export function validateShotTips(out: ShotTipsOutput, refs: readonly string[]): { errors: string[] } {
  const errors: string[] = [];
  const known = new Set(refs);
  const seen = new Set<string>();
  out.shots.forEach((it, i) => {
    const n = `第 ${i + 1} 项（${it.ref}）`;
    if (!known.has(it.ref)) errors.push(`${n}：ref 不是本场的镜头编号，只能是 ${refs.join('、')}`);
    else if (seen.has(it.ref)) errors.push(`${n}：这个镜头已经写过一项，每个镜头恰好一项`);
    seen.add(it.ref);
    const tips = it.tips.map((t) => t.trim()).filter(Boolean);
    if (tips.length < TIPS_MIN || tips.length > TIPS_MAX) errors.push(`${n}：tips 要写 ${TIPS_MIN}–${TIPS_MAX} 条（现在 ${tips.length} 条）`);
    tips.forEach((t, k) => {
      if (len(t) > TIP_TEXT_MAX) errors.push(`${n}：第 ${k + 1} 条提示超过 ${TIP_TEXT_MAX} 字，请缩短`);
    });
    if (!it.mistake.trim()) errors.push(`${n}：mistake 不能为空，写一个最常见的失误`);
    else if (len(it.mistake.trim()) > TIP_TEXT_MAX) errors.push(`${n}：mistake 超过 ${TIP_TEXT_MAX} 字，请缩短`);
    if ([...tips, it.mistake].some(claims)) errors.push(`${n}：不要写片名、导演或声称某部电影是这样拍的`);
  });
  const missing = refs.filter((r) => !seen.has(r));
  if (missing.length) errors.push(`缺少 ${missing.join('、')} 的提示：每个镜头恰好一项`);
  return { errors };
}

export interface FinalizedTip {
  ref: string;
  difficulty: ShotDifficulty;
  gear: ShotGear[];
  tips: string[];
  mistake: string;
}

export interface FinalizedShotTips {
  items: FinalizedTip[];
  /** items left out (unknown or repeated shot, too few usable tips, no mistake) */
  dropped: number;
  /** shots of the scene without an item */
  missing: string[];
}

/** What is kept of an answer: one item per known shot, texts cut to the limit, film claims left out. */
export function finalizeShotTips(out: ShotTipsOutput, refs: readonly string[]): FinalizedShotTips {
  const known = new Set(refs);
  const kept = new Map<string, FinalizedTip>();
  let dropped = 0;
  for (const it of out.shots) {
    const tips = it.tips
      .map((t) => t.trim())
      .filter((t) => t && !claims(t))
      .slice(0, TIPS_MAX)
      .map((t) => cut(t, TIP_TEXT_MAX));
    const mistake = it.mistake.trim();
    if (!known.has(it.ref) || kept.has(it.ref) || tips.length < TIPS_MIN || !mistake || claims(mistake)) {
      dropped++;
      continue;
    }
    kept.set(it.ref, { ref: it.ref, difficulty: it.difficulty, gear: [...new Set(it.gear)], tips, mistake: cut(mistake, TIP_TEXT_MAX) });
  }
  return { items: refs.filter((r) => kept.has(r)).map((r) => kept.get(r)!), dropped, missing: refs.filter((r) => !kept.has(r)) };
}
