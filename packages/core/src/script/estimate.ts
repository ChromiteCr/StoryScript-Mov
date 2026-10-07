import type { Paragraph, SceneEstimate, SceneIntExt, ScriptEstimate } from '@storyscript/contracts';

/**
 * S5 剧本体检 — rough screen time from the text alone (no model):
 *
 * - units: a CJK character (Han, kana, Hangul) is 1, a Latin word 1.5
 *   (about 150 English words a minute against 240 Chinese characters);
 *   punctuation and spaces count nothing
 * - dialogue is spoken at 4 units a second, action plays at 2.5, and each
 *   scene gets 3 seconds for its establishing beat and the cut into it
 * - dialogue lines are `角色：台词` / `角色（轻声）：台词` (a short name of
 *   at most six characters, not a label such as 时间 or 地点) and Fountain
 *   blocks (a cue line, then the lines spoken); parentheticals are not spoken
 * - the range shown is ×0.75 … ×1.3: it is a rough guide, not a timing
 */

export const DIALOGUE_UNITS_PER_S = 4;
export const ACTION_UNITS_PER_S = 2.5;
export const SCENE_PAD_S = 3;
export const ESTIMATE_LOW = 0.75;
export const ESTIMATE_HIGH = 1.3;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_WORD = /[A-Za-z0-9À-ɏ]+(?:['’][A-Za-z]+)?/g;

/** Spoken / read units of a text. */
export function textUnits(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, ' ').match(LATIN_WORD)?.length ?? 0;
  return cjk + words * 1.5;
}

/** Labels that look like `名字：` but introduce notes, not speech. */
const NOT_CUES = new Set([
  '人物', '出场人物', '出场', '时间', '地点', '场景', '场次', '景别', '备注', '注', '道具', '服装', '演员', '角色',
  '镜头', '字幕', '画面', '内景', '外景', '标题', '剧名', '编剧', '片名', '天气', '季节', '提示', '音乐', '音效',
]);
const PAREN = /[（(][^）)]*[）)]/g;
const CUE = /^\s*([^\s：:，,。.！!？?、；;“”"'‘’（）()[\]【】《》]{1,10})\s*(?:[（(][^）)]{0,24}[）)])?\s*[：:]\s*(.*)$/u;
const FOUNTAIN_CUE = /^@?[A-Z][A-Z0-9 .'’-]{1,38}(?:\s*\([^)]*\))?\s*(?:\^)?$/;
const HAN_CUE = /^@?[\p{Script=Han}·]{1,6}(?:\s*[（(][^）)]{0,24}[）)])?$/u;
const ONLY_PAREN = /^\s*[（(][^）)]*[）)]\s*$/;

function speechOf(cueLine: string): string | null {
  const m = CUE.exec(cueLine);
  if (!m) return null;
  const cue = m[1]!;
  // a name is short: 「他看了一眼电子屏：00:02」 is a description
  if (NOT_CUES.has(cue) || cue.endsWith('着') || (/^\p{Script=Han}+$/u.test(cue) && cue.length > 6)) return null;
  return m[2]!;
}

/** Dialogue and action units of one paragraph (headings count nothing). */
export function paragraphUnits(text: string): { dialogue: number; action: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let dialogue = 0;
  let action = 0;
  // a Fountain-style block: a cue line alone, then what is said
  const first = lines[0]?.trim() ?? '';
  if (lines.length >= 2 && (FOUNTAIN_CUE.test(first) || HAN_CUE.test(first)) && !/[：:]/.test(first)) {
    for (const line of lines.slice(1)) {
      if (ONLY_PAREN.test(line)) continue;
      dialogue += textUnits(line.replace(PAREN, ''));
    }
    return { dialogue, action };
  }
  for (const line of lines) {
    const speech = speechOf(line);
    if (speech !== null) dialogue += textUnits(speech.replace(PAREN, ''));
    else action += textUnits(line);
  }
  return { dialogue, action };
}

/** 内 / 外 from a scene heading (内景、外景、INT、EXT, 内外). */
export function sceneIntExt(heading: string): SceneIntExt | null {
  const h = heading.toUpperCase();
  if (/内外|内\s*[/／]\s*外|外\s*[/／]\s*内|INT\.?\s*[/／]\s*EXT|EXT\.?\s*[/／]\s*INT|\bI\/E\b/.test(h)) return 'int_ext';
  const sep = '(?:^|[\\s.,，、。:：/／|·-]|\\d)';
  const end = '(?:$|[\\s.,，、。:：/／|·-])';
  const int = /内景|\bINT\b/.test(h) || new RegExp(`${sep}内${end}`).test(h);
  const ext = /外景|\bEXT\b/.test(h) || new RegExp(`${sep}外${end}`).test(h);
  if (int && ext) return 'int_ext';
  return int ? 'int' : ext ? 'ext' : null;
}

export interface EstimateSceneInput {
  id: string;
  display_no: string;
  heading: string;
  paragraph_ids: readonly string[];
  time_label: string | null;
}

export interface EstimateOptions {
  /** live shots' est_seconds per scene id */
  shotSeconds?: ReadonlyMap<string, number>;
  target_seconds?: number | null;
}

export function estimateScript(
  paragraphs: readonly Pick<Paragraph, 'id' | 'text' | 'is_heading'>[],
  scenes: readonly EstimateSceneInput[],
  opts: EstimateOptions = {},
): ScriptEstimate {
  const byId = new Map(paragraphs.map((p) => [p.id, p] as const));
  const out: SceneEstimate[] = scenes.map((scene) => {
    let dialogue = 0;
    let action = 0;
    for (const pid of scene.paragraph_ids) {
      const p = byId.get(pid);
      if (!p || p.is_heading) continue;
      const u = paragraphUnits(p.text);
      dialogue += u.dialogue;
      action += u.action;
    }
    const empty = dialogue === 0 && action === 0;
    const seconds = empty ? 0 : Math.round(dialogue / DIALOGUE_UNITS_PER_S + action / ACTION_UNITS_PER_S + SCENE_PAD_S);
    const shots = opts.shotSeconds?.get(scene.id);
    return {
      scene_id: scene.id,
      display_no: scene.display_no,
      heading: scene.heading,
      seconds,
      dialogue_units: dialogue,
      action_units: action,
      shots_seconds: shots === undefined ? null : Math.round(shots * 10) / 10,
      int_ext: sceneIntExt(scene.heading),
      time_label: scene.time_label,
    };
  });
  const seconds = out.reduce((n, s) => n + s.seconds, 0);
  return {
    seconds,
    low_seconds: Math.round(seconds * ESTIMATE_LOW),
    high_seconds: Math.round(seconds * ESTIMATE_HIGH),
    target_seconds: opts.target_seconds ?? null,
    scenes: out,
  };
}
