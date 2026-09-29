import type { CameraAngle, Movement, ShotFields, ShotSize, SourceRef } from '@storyscript/contracts';
import { CN_NUMERAL_CHARS, parseSceneNumeral } from './numerals.ts';

/**
 * Shot lines (S2c). Students often hand in a shot list instead of a
 * screenplay: one shot per line ("3. 近景 小明推门进来 3秒"), or a table pasted
 * from Word/Excel ("镜号 | 景别 | 画面 | 时长"). Such a line names a shot, never
 * a scene. Pure: text in, facts out; the vocabulary maps onto the ShotFields
 * enums, anything not written stays unknown (null) for the caller to default.
 */

export interface ShotLineInfo {
  /** the number the writer gave the shot ("12", "3-2"), if any */
  code: string | null;
  shot_size: ShotSize | null;
  angle: CameraAngle | null;
  movement: Movement | null;
  /** over-the-shoulder was written */
  ots: boolean;
  /** point-of-view was written */
  pov: boolean;
  est_seconds: number | null;
  dialogue: string | null;
  /** what the frame shows, with the recognised terms taken out */
  action: string;
  /** table columns only */
  location: string | null;
  time_label: string | null;
  /** table "场次" column: a change starts a new scene */
  scene_key: string | null;
}

export type ShotColumn = 'code' | 'scene' | 'size' | 'movement' | 'angle' | 'action' | 'dialogue' | 'seconds' | 'location' | 'time' | 'notes' | 'other';

export interface ShotTable {
  sep: '\t' | '|';
  columns: ShotColumn[];
}

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** longest first where one contains another (大远景 before 远景, 中近景 before 近景) */
const SIZE_WORDS: readonly (readonly [string, ShotSize])[] = [
  ['大远景', 'EWS'],
  ['极远景', 'EWS'],
  ['超远景', 'EWS'],
  ['大全景', 'WS'],
  ['中全景', 'MLS'],
  ['小全景', 'MLS'],
  ['中近景', 'MCU'],
  ['大特写', 'ECU'],
  ['极特写', 'ECU'],
  ['插入镜头', 'INSERT'],
  ['空镜头', 'INSERT'],
  ['远景', 'WS'],
  ['全景', 'FS'],
  ['中景', 'MS'],
  ['近景', 'MCU'],
  ['特写', 'CU'],
  ['空镜', 'INSERT'],
  ['插入', 'INSERT'],
];
const SIZE_EN: Readonly<Record<string, ShotSize>> = {
  EWS: 'EWS',
  ELS: 'EWS',
  XLS: 'EWS',
  WS: 'WS',
  LS: 'WS',
  FS: 'FS',
  MLS: 'MLS',
  MWS: 'MLS',
  MS: 'MS',
  MCU: 'MCU',
  CU: 'CU',
  ECU: 'ECU',
  XCU: 'ECU',
  INSERT: 'INSERT',
};

/** unambiguous as substrings */
const ANGLE_WORDS: readonly (readonly [string, CameraAngle])[] = [
  ['俯拍', 'high'],
  ['俯视', 'high'],
  ['俯角', 'high'],
  ['仰拍', 'low'],
  ['仰视', 'low'],
  ['仰角', 'low'],
  ['顶拍', 'overhead'],
  ['鸟瞰', 'overhead'],
  ['正俯', 'overhead'],
  ['平视', 'eye'],
  ['平拍', 'eye'],
  ['荷兰角', 'dutch'],
  ['斜角镜头', 'dutch'],
];

/** only as whole tokens (or a token made only of these): "推门" or "手持雨伞" are actions, not moves */
const MOVE_WORDS: readonly (readonly [string, Movement])[] = [
  ['固定镜头', 'static'],
  ['固定', 'static'],
  ['静止', 'static'],
  ['定镜', 'static'],
  ['推镜头', 'push_in'],
  ['推镜', 'push_in'],
  ['推近', 'push_in'],
  ['推进', 'push_in'],
  ['慢推', 'push_in'],
  ['缓推', 'push_in'],
  ['推', 'push_in'],
  ['拉镜头', 'pull_out'],
  ['拉镜', 'pull_out'],
  ['拉远', 'pull_out'],
  ['拉出', 'pull_out'],
  ['后拉', 'pull_out'],
  ['拉', 'pull_out'],
  ['竖摇', 'tilt'],
  ['上摇', 'tilt'],
  ['下摇', 'tilt'],
  ['摇镜头', 'pan'],
  ['摇镜', 'pan'],
  ['横摇', 'pan'],
  ['左摇', 'pan'],
  ['右摇', 'pan'],
  ['摇摄', 'pan'],
  ['摇臂', 'crane'],
  ['摇', 'pan'],
  ['移镜头', 'track'],
  ['移镜', 'track'],
  ['横移', 'track'],
  ['跟镜头', 'track'],
  ['跟拍', 'track'],
  ['跟镜', 'track'],
  ['跟移', 'track'],
  ['前跟', 'track'],
  ['后跟', 'track'],
  ['轨道', 'track'],
  ['滑轨', 'track'],
  ['移', 'track'],
  ['跟', 'track'],
  ['升降', 'crane'],
  ['航拍', 'aerial'],
  ['环绕', 'orbit'],
  ['环拍', 'orbit'],
  ['变焦推拉', 'dolly_zoom'],
  ['滑动变焦', 'dolly_zoom'],
  ['升镜', 'crane'],
  ['降镜', 'crane'],
  ['升', 'crane'],
  ['降', 'crane'],
  ['手持', 'handheld'],
  ['车拍', 'vehicle'],
  ['车载', 'vehicle'],
];
const MOVE_EN: Readonly<Record<string, Movement>> = {
  STATIC: 'static',
  FIXED: 'static',
  PUSH: 'push_in',
  DOLLY: 'track',
  PULL: 'pull_out',
  PAN: 'pan',
  TILT: 'tilt',
  TRACK: 'track',
  TRACKING: 'track',
  CRANE: 'crane',
  HANDHELD: 'handheld',
};
const OTS_WORDS = ['过肩', 'OTS', 'OS'];
const POV_WORDS = ['主观镜头', '主观', 'POV'];

const TOKEN_SEP = /[\s,，、;；/／|｜:：()（）【】[\]「」+＋]+/;

/** A token made only of movement words ("手持跟拍") → the first move; null otherwise. */
function moveOfToken(token: string): Movement | null {
  const upper = token.toUpperCase();
  if (MOVE_EN[upper]) return MOVE_EN[upper]!;
  let rest = token;
  let first: Movement | null = null;
  while (rest.length > 0) {
    const hit = MOVE_WORDS.find(([w]) => rest.startsWith(w));
    if (!hit) return null;
    first ??= hit[1];
    rest = rest.slice(hit[0].length);
  }
  return first;
}

function sizeOfToken(token: string): ShotSize | null {
  return SIZE_EN[token.toUpperCase()] ?? SIZE_WORDS.find(([w]) => w === token)?.[1] ?? null;
}

/** First size word anywhere in the text (sizes are unambiguous), with where it was. */
function findSize(text: string): { size: ShotSize; word: string } | null {
  for (let i = 0; i < text.length; i++) {
    for (const [w, size] of SIZE_WORDS) if (text.startsWith(w, i)) return { size, word: w };
  }
  for (const tok of text.split(TOKEN_SEP)) {
    const s = SIZE_EN[tok.toUpperCase()];
    if (s) return { size: s, word: tok };
  }
  return null;
}

function hasCameraToken(text: string): boolean {
  const tokens = text.split(TOKEN_SEP).filter(Boolean);
  if (tokens.some((t) => moveOfToken(t) !== null || OTS_WORDS.includes(t.toUpperCase()) || POV_WORDS.includes(t.toUpperCase()))) return true;
  return ANGLE_WORDS.some(([w]) => text.includes(w)) || POV_WORDS.slice(0, 1).some((w) => text.includes(w));
}

// ---------------------------------------------------------------------------
// line shapes
// ---------------------------------------------------------------------------

const NUM = `[0-9０-９]+|[${CN_NUMERAL_CHARS}]+`;
/** "镜头3" "镜号 12" "Shot 4" */
const SHOT_PREFIX = new RegExp(`^(?:镜头|镜号|镜|shot)\\s*(?:no\\.?|#|＃)?\\s*(${NUM})(?:\\s*[.、．:：)）]\\s*|\\s+|$)`, 'i');
/** "3-2" "S1-03" "sc2-4": scene-shot numbering */
const SCENE_SHOT = /^(?:s(?:c)?\.?)?([0-9０-９]+)\s*[-－–—_]\s*([0-9０-９]+)(?=\s|[.、．:：)）]|$)/i;
/** "12. …" "12、…" "十二、…" */
const NUMBERED = new RegExp(`^(${NUM})\\s*(?:[.、．:：)）]\\s*|\\s+)(.+)$`);

function sizeAtStart(t: string): string | null {
  const hit = SIZE_WORDS.find(([w]) => t.startsWith(w));
  if (!hit) return null;
  const next = t.slice(hit[0].length, hit[0].length + 1);
  return next === '' || TOKEN_SEP.test(next) ? hit[0] : null;
}

/** Scene-shot numbered line whose rest reads like a scene heading ("1-1 内景 客厅 日" is episode-scene). */
export type LooksLikeHeading = (rest: string) => boolean;

/**
 * Is this line a shot (outside a table)? `looksLikeHeading` lets the scene
 * splitter keep "1-1 日 内 客厅" (episode 1, scene 1) as a heading.
 */
export function isShotLine(line: string, looksLikeHeading: LooksLikeHeading = () => false): boolean {
  const t = line.trim().normalize('NFKC');
  if (!t) return false;
  if (SHOT_PREFIX.test(t)) return true;
  const ss = SCENE_SHOT.exec(t);
  if (ss) {
    const rest = t.slice(ss[0].length).replace(/^[\s.、．:：)）]+/, '');
    if (findSize(rest) || hasCameraToken(rest)) return true;
    return !looksLikeHeading(rest);
  }
  const numbered = NUMBERED.exec(t);
  if (numbered) {
    const rest = numbered[2]!;
    return findSize(rest) !== null || hasCameraToken(rest);
  }
  return sizeAtStart(t) !== null;
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

const COLUMN_WORDS: readonly (readonly [ShotColumn, readonly string[]])[] = [
  ['code', ['镜号', '镜头号', '序号', '编号', '镜次', '镜头', 'NO', 'NO.', '#', 'SHOT']],
  ['scene', ['场次', '场号', '场', 'SCENE']],
  ['size', ['景别', '景', 'SIZE']],
  ['movement', ['运镜', '镜头运动', '运动', '拍摄方式', '摄法', '机位运动', 'MOVEMENT']],
  ['angle', ['角度', '机位', '拍摄角度', 'ANGLE']],
  ['action', ['画面', '画面内容', '内容', '镜头内容', '描述', '画面描述', '动作', 'ACTION', 'DESCRIPTION']],
  ['dialogue', ['台词', '对白', '声音', '旁白', '音效', 'DIALOGUE']],
  ['seconds', ['时长', '时间', '秒数', '长度', 'DURATION']],
  ['location', ['场景', '地点', '拍摄地点', '场地', 'LOCATION']],
  ['time', ['日夜', '时段', '内外', '日/夜', '内/外']],
  ['notes', ['备注', '说明', 'NOTES', 'NOTE']],
];

function columnOf(cell: string): ShotColumn {
  const c = cell
    .normalize('NFKC')
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  for (const [role, words] of COLUMN_WORDS) if (words.includes(c)) return role;
  return 'other';
}

function splitCells(line: string, sep: '\t' | '|'): string[] {
  let cells = line.split(sep === '\t' ? '\t' : /[|｜]/).map((c) => c.trim());
  if (sep === '|') {
    if (cells[0] === '') cells = cells.slice(1);
    if (cells.at(-1) === '') cells = cells.slice(0, -1);
  }
  return cells;
}

function sepOf(line: string): '\t' | '|' | null {
  if (line.includes('\t')) return '\t';
  return (line.match(/[|｜]/g)?.length ?? 0) >= 2 ? '|' : null;
}

/** A shot-list table header: at least two known columns, one of them 镜号 / 景别 / 画面. */
export function detectShotTable(line: string): ShotTable | null {
  const sep = sepOf(line);
  if (!sep) return null;
  const columns = splitCells(line, sep).map(columnOf);
  const known = columns.filter((c) => c !== 'other');
  if (known.length < 2 || !columns.some((c) => c === 'code' || c === 'size' || c === 'action')) return null;
  return { sep, columns };
}

/** Markdown "|---|:---:|" rule under a header. */
export function isTableRule(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

/** A data row of the table: same separator, at least two cells with content. */
export function isTableRow(line: string, table: ShotTable): boolean {
  if (sepOf(line) !== table.sep) return false;
  return splitCells(line, table.sep).filter(Boolean).length >= 2;
}

// ---------------------------------------------------------------------------
// parsing one shot
// ---------------------------------------------------------------------------

const SECONDS = new RegExp(`(\\d+(?:\\.\\d+)?|[${CN_NUMERAL_CHARS}]+)\\s*(?:秒钟?|s(?:ec)?\\b|''|″|")`, 'i');
const QUOTE = /[“"「『]([^”"」』]+)[”"」』]/;
const DIALOGUE_LABEL = /(?:台词|对白|旁白)\s*[：:]\s*(.+)$/;

function secondsOf(text: string): number | null {
  const m = SECONDS.exec(text.normalize('NFKC'));
  if (!m) return null;
  const n = /^\d/.test(m[1]!) ? parseFloat(m[1]!) : parseSceneNumeral(m[1]!);
  return n !== null && n > 0 ? Math.min(n, 120) : null;
}

function empty(): ShotLineInfo {
  return {
    code: null,
    shot_size: null,
    angle: null,
    movement: null,
    ots: false,
    pov: false,
    est_seconds: null,
    dialogue: null,
    action: '',
    location: null,
    time_label: null,
    scene_key: null,
  };
}

/** Size, angle, movement, OTS/POV found in free text; `rest` is the text without those terms. */
function camera(text: string): Pick<ShotLineInfo, 'shot_size' | 'angle' | 'movement' | 'ots' | 'pov'> & { rest: string } {
  let rest = text;
  const size = findSize(rest);
  if (size) rest = rest.replace(size.word, ' ');
  let angle: CameraAngle | null = null;
  for (const [w, a] of ANGLE_WORDS) {
    if (rest.includes(w)) {
      angle = a;
      rest = rest.replace(w, ' ');
      break;
    }
  }
  let movement: Movement | null = null;
  let ots = false;
  let pov = false;
  const kept: string[] = [];
  for (const tok of rest.split(/(\s+|[,，、;；/／|｜:：()（）【】[\]「」+＋]+)/)) {
    const bare = tok.trim();
    const up = bare.toUpperCase();
    if (bare && OTS_WORDS.includes(up)) ots = true;
    else if (bare && POV_WORDS.includes(up)) pov = true;
    else {
      const m = bare ? moveOfToken(bare) : null;
      if (m) movement ??= m;
      else {
        kept.push(tok);
        continue;
      }
    }
    kept.push(' ');
  }
  if (!pov && rest.includes('主观镜头')) pov = true;
  return { shot_size: size?.size ?? null, angle, movement, ots, pov, rest: kept.join('') };
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,，、;；:：.。|｜-]+|[\s,，、;；:：|｜-]+$/g, '')
    .trim();
}

/** Parse a free-form shot line ("3. 近景 仰拍 小明推门进来，“我回来了。” 3秒"). */
export function parseShotLine(line: string): ShotLineInfo {
  const out = empty();
  let t = line.trim();
  const num = (v: string) => String(parseSceneNumeral(v) ?? v.normalize('NFKC'));
  const shotPrefix = SHOT_PREFIX.exec(t);
  const sceneShot = shotPrefix ? null : SCENE_SHOT.exec(t);
  const numbered = shotPrefix || sceneShot ? null : NUMBERED.exec(t);
  if (shotPrefix) {
    out.code = num(shotPrefix[1]!);
    t = t.slice(shotPrefix[0].length);
  } else if (sceneShot) {
    out.code = `${num(sceneShot[1]!)}-${num(sceneShot[2]!)}`;
    t = t.slice(sceneShot[0].length);
  } else if (numbered) {
    out.code = num(numbered[1]!);
    t = numbered[2]!;
  }
  const labelled = DIALOGUE_LABEL.exec(t);
  if (labelled) {
    out.dialogue = labelled[1]!.replace(/^[“"「『]|[”"」』]$/g, '').trim() || null;
    t = t.slice(0, labelled.index);
  } else {
    const q = QUOTE.exec(t);
    if (q) {
      out.dialogue = q[1]!.trim();
      t = t.replace(q[0], ' ');
    }
  }
  const secs = secondsOf(t);
  if (secs !== null) {
    out.est_seconds = secs;
    t = t.replace(SECONDS, ' ');
  }
  const cam = camera(t);
  out.shot_size = cam.shot_size;
  out.angle = cam.angle;
  out.movement = cam.movement;
  out.ots = cam.ots;
  out.pov = cam.pov;
  out.action = tidy(cam.rest);
  return out;
}

/** Parse one data row of a shot-list table. */
export function parseTableRow(line: string, table: ShotTable): ShotLineInfo {
  const out = empty();
  const cells = splitCells(line, table.sep);
  const extra: string[] = [];
  table.columns.forEach((col, i) => {
    const v = (cells[i] ?? '').trim();
    if (!v) return;
    switch (col) {
      case 'code':
        out.code = v;
        break;
      case 'scene':
        out.scene_key = v;
        break;
      case 'size': {
        const c = camera(v);
        out.shot_size = c.shot_size ?? sizeOfToken(v);
        out.angle ??= c.angle;
        out.movement ??= c.movement;
        break;
      }
      case 'movement':
      case 'angle': {
        const c = camera(v);
        out.movement ??= c.movement;
        out.angle ??= c.angle;
        out.ots ||= c.ots;
        out.pov ||= c.pov;
        break;
      }
      case 'action':
        out.action = out.action ? `${out.action} ${v}` : v;
        break;
      case 'dialogue':
        out.dialogue = v.replace(/^[“"「『]|[”"」』]$/g, '') || null;
        break;
      case 'seconds':
        out.est_seconds = secondsOf(/秒|s|''|″|"/i.test(v) ? v : `${v}秒`);
        // some tables put 日/夜 under 时间
        if (out.est_seconds === null && v.length <= 4) out.time_label ??= v;
        break;
      case 'location':
        out.location = v;
        break;
      case 'time':
        out.time_label = v;
        break;
      case 'notes':
        extra.push(`备注：${v}`);
        break;
      default:
        extra.push(v);
    }
  });
  if (extra.length) out.action = [out.action, ...extra].filter(Boolean).join('；');
  return out;
}

// ---------------------------------------------------------------------------
// to ShotFields
// ---------------------------------------------------------------------------

export const DEFAULT_SHOT_SECONDS = 3;

/** Full ShotFields for a manual shot made from a shot line; what was not written gets a stated default. */
export function shotFieldsFromLine(info: ShotLineInfo, source: SourceRef): ShotFields {
  const assumptions: string[] = [];
  if (!info.shot_size) assumptions.push('分镜脚本没写景别，暂按中景');
  if (info.est_seconds === null) assumptions.push(`分镜脚本没写时长，暂按 ${DEFAULT_SHOT_SECONDS} 秒`);
  if (info.pov) assumptions.push('原文写的是主观镜头');
  const size = info.shot_size ?? 'MS';
  return {
    template: size === 'INSERT' ? 'insert' : info.ots ? 'ots' : null,
    shot_size: size,
    angle: info.angle ?? 'eye',
    lens: 'normal',
    focal_mm: null,
    movement: info.movement ?? 'static',
    subjects: [],
    props: [],
    env: null,
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: info.est_seconds ?? DEFAULT_SHOT_SECONDS,
    narrative_purpose: '',
    action: info.action || source.quote,
    dialogue_quote: info.dialogue,
    source,
    assumptions,
    questions: [],
  };
}
