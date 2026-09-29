import type { Paragraph, ParsedScript, ScriptFormat } from '@storyscript/contracts';
import { CN_NUMERAL_CHARS, parseSceneNumeral } from './numerals.ts';
import { detectShotTable, isShotLine, isTableRow, isTableRule, parseShotLine, parseTableRow, type ShotLineInfo, type ShotTable } from './shot-line.ts';

export { parseSceneNumeral } from './numerals.ts';

/**
 * Rule-based scene splitter (SPEC FR-02). Pure: text in, ParsedScript out.
 *
 * - Consecutive non-empty lines form one paragraph (a Fountain dialogue block
 *   — character / parenthetical / dialogue — is therefore one paragraph).
 *   Every non-empty paragraph gets an anchor p-001, p-002 … (3 digits minimum,
 *   more when needed).
 * - Scene headings are detected per line and always stand alone as their own
 *   paragraph, even without blank lines around them.
 * - `headingOverrides` force a line to be (or not be) a heading.
 * - S2c: shot lines ("3. 近景 小明推门" or rows of a 镜号/景别/画面 table,
 *   shot-line.ts) are never headings; they stand alone like headings do. A
 *   text made mostly of them is a shot list: its shots without a heading get
 *   an implicit scene (a new one when the table's 场次 or 场景/地点 changes).
 */

export interface HeadingOverrideInput {
  /** 1-based raw line number */
  line: number;
  is_heading: boolean;
}

export interface ShotOverrideInput {
  /** 1-based raw line number */
  line: number;
  is_shot: boolean;
}

export type ScriptKind = 'screenplay' | 'shot_list';

export interface ParsedShotLine {
  /** 1-based raw line number */
  line: number;
  paragraph_id: string;
  /** null: before any scene (a screenplay's stray shot line) */
  scene_idx: number | null;
  info: ShotLineInfo;
}

export interface ParsedScriptWithDetection extends ParsedScript {
  /** 1-based line numbers the rules detected as scene headings (before overrides) */
  detected_heading_lines: number[];
  /** 1-based line numbers the rules detected as shot lines (before overrides) */
  detected_shot_lines: number[];
  kind: ScriptKind;
  shot_lines: ParsedShotLine[];
}

export interface ParseOptions {
  shotOverrides?: readonly ShotOverrideInput[];
  /** heading of the implicit scene of a shot list without headings (e.g. the file name) */
  untitledScene?: string;
}

export interface HeadingInfo {
  /** explicit scene number written in the heading, if any */
  display_no: string | null;
  /** heading text without the scene number */
  heading: string;
  time_label: string | null;
  location_label: string | null;
  /** an unmistakable scene marker (第3场, 场景一, S1, INT., forced ".") that beats shot-line rules */
  explicit: boolean;
}

// ---------------------------------------------------------------------------
// token classification
// ---------------------------------------------------------------------------

const IE_TOKEN = /^(内景|外景|内外景|内\/外景?|外\/内景?|内|外|INT\.?|EXT\.?|INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E|E\/I)$/i;
/** strong interior/exterior words: enough on their own for a bare heading */
const IE_STRONG = /^(内景|外景|内外景|内\/外景|外\/内景|INT\.?|EXT\.?)$/i;
const TIME_TOKEN =
  /^(日|夜|晨|昏|早|晚|黄昏|傍晚|清晨|早晨|早上|上午|中午|正午|午后|下午|晚上|夜晚|深夜|午夜|凌晨|黎明|白天|日间|夜间|日出|日落|雨夜|雪夜|日景|夜景|DAY|NIGHT|MORNING|EVENING|DUSK|DAWN|AFTERNOON|CONTINUOUS|LATER|MOMENTS LATER|SAME)$/i;
/** "日内" / "夜外": time and interior/exterior glued together */
const TIME_IE_TOKEN = /^(日|夜)(内|外)$/;

const TOKEN_SPLIT = /[\s·•・|｜，,、（）()【】[\]「」：:]+|[-–—]+/;
const SENTENCE_END = /[。！？!?…]$|\.\.\.$/;

interface TokenScan {
  ie: boolean;
  strongIe: boolean;
  time: string | null;
  location: string | null;
  count: number;
}

function scanTokens(rest: string): TokenScan {
  const tokens = rest.split(TOKEN_SPLIT).filter((t) => t.length > 0);
  let ie = false;
  let strongIe = false;
  let time: string | null = null;
  const loc: string[] = [];
  for (const tok of tokens) {
    const glued = TIME_IE_TOKEN.exec(tok);
    if (glued) {
      ie = true;
      time = glued[1]!;
      continue;
    }
    if (IE_TOKEN.test(tok)) {
      ie = true;
      if (IE_STRONG.test(tok)) strongIe = true;
      continue;
    }
    if (TIME_TOKEN.test(tok)) {
      time = tok;
      continue;
    }
    loc.push(tok);
  }
  return { ie, strongIe, time, location: loc.length ? loc.join(' ') : null, count: tokens.length };
}

// ---------------------------------------------------------------------------
// heading detection
// ---------------------------------------------------------------------------

const MD_HEADING = /^#{1,6}\s+(.*)$/;
const FOUNTAIN_SCENE_NO = /\s*#([A-Za-z0-9.\-]+)#\s*$/;
const FOUNTAIN_PREFIX = /^(INT\.?\/EXT|EXT\.?\/INT|INT\/EXT|EXT\/INT|I\/E|E\/I|INT|EXT|EST)(?:\.|\s)\s*(.*)$/i;
const FOUNTAIN_FORCED = /^\.(?![.\s])(.+)$/;
const CN_DI_CHANG = /^第\s*([0-9０-９一二三四五六七八九十百零〇两]+)\s*场(?:\s+|[：:.、．]\s*|$)(.*)$/;
/** 场3 / 场景一 / 场次 12 */
const CN_CHANG = new RegExp(`^场(?:景|次)?\\s*([0-9０-９]+[A-Za-z]?|[${CN_NUMERAL_CHARS}]+)(?:\\s+|[：:.、．]\\s*|$)(.*)$`);
/** S1 / Sc.2 / SC 3 / Scene 4 (not "S1-03", which is a shot) */
const EN_SCENE = /^(?:scene|sc|s)\.?\s*([0-9０-９]+[A-Za-z]?)(?:\s+|[：:.、．]\s*|$)(.*)$/i;
const CN_NUMBERED = /^([0-9０-９]+[A-Za-z]?)\s*(?:[.、．:：)）]\s*|\s+)(.+)$/;
/** 一、教室 日 (a Chinese numeral needs a real separator) */
const CN_ENUM = new RegExp(`^([${CN_NUMERAL_CHARS}]+)\\s*[、.．:：]\\s*(.+)$`);

/** Fountain-style "LOCATION - TIME" split, falling back to a trailing time word. */
function fountainParts(rest: string): { time: string | null; location: string | null } {
  const segments = rest
    .split(/\s+[-–—]+\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length > 1 && TIME_TOKEN.test(segments[segments.length - 1]!)) {
    return { time: segments[segments.length - 1]!, location: segments.slice(0, -1).join(' - ') || null };
  }
  const scan = scanTokens(rest);
  return { time: scan.time, location: rest.trim() ? (scan.time ? scan.location : rest.trim()) : null };
}

function numberString(raw: string): string {
  const n = parseSceneNumeral(raw.replace(/[A-Za-z]+$/, ''));
  const suffix = /[A-Za-z]+$/.exec(raw)?.[0] ?? '';
  return n === null ? raw.normalize('NFKC') : `${n}${suffix}`;
}

function chineseInfo(no: string | null, rest: string, fallback: string, explicit: boolean): HeadingInfo {
  const scan = scanTokens(rest);
  const heading = rest.trim() || fallback;
  return { display_no: no, heading, time_label: scan.time, location_label: scan.location, explicit };
}

/** The rest of a numbered line reads like a scene heading (interior/exterior or time words). */
export function readsLikeHeading(rest: string): boolean {
  const scan = scanTokens(rest);
  return scan.ie || scan.time !== null;
}

export interface DetectOptions {
  /** allow the Fountain forced heading ".HEADING" (fountain / paste only) */
  forcedDot: boolean;
}

/**
 * Line-level scene heading rules. Returns null when the line is not a heading.
 * `line` must already be trimmed.
 */
export function detectHeading(line: string, opts: DetectOptions = { forcedDot: true }): HeadingInfo | null {
  let t = line.trim();
  if (!t) return null;
  const md = MD_HEADING.exec(t);
  if (md) t = md[1]!.trim();
  if (!t) return null;

  // Fountain scene number "#1A#"
  let sceneNo: string | null = null;
  const numMatch = FOUNTAIN_SCENE_NO.exec(t);
  if (numMatch && numMatch.index > 0) {
    sceneNo = numMatch[1]!;
    t = t.slice(0, numMatch.index).trim();
  }

  if (opts.forcedDot) {
    const forced = FOUNTAIN_FORCED.exec(t);
    if (forced) {
      const heading = forced[1]!.trim();
      const parts = fountainParts(heading);
      return { display_no: sceneNo, heading, time_label: parts.time, location_label: parts.location, explicit: true };
    }
  }

  const fountain = FOUNTAIN_PREFIX.exec(t);
  if (fountain) {
    const parts = fountainParts(fountain[2] ?? '');
    return { display_no: sceneNo, heading: t, time_label: parts.time, location_label: parts.location, explicit: true };
  }
  if (sceneNo !== null) return null; // "#1#" alone does not make a heading

  const di = CN_DI_CHANG.exec(t);
  if (di) return chineseInfo(numberString(di[1]!), di[2] ?? '', t, true);

  const chang = CN_CHANG.exec(t);
  if (chang) return chineseInfo(numberString(chang[1]!), chang[2] ?? '', t, true);

  if (t.length > 60 || SENTENCE_END.test(t)) return null;

  const en = EN_SCENE.exec(t);
  if (en) return chineseInfo(numberString(en[1]!), en[2] ?? '', t, true);

  const numbered = CN_NUMBERED.exec(t) ?? CN_ENUM.exec(t);
  if (numbered) {
    const rest = numbered[2]!.trim();
    if (readsLikeHeading(rest)) return chineseInfo(numberString(numbered[1]!), rest, t, false);
    return null;
  }

  if (t.length > 40) return null;
  const scan = scanTokens(t);
  if ((scan.ie && scan.time) || (scan.strongIe && scan.count >= 2)) {
    return { display_no: null, heading: t, time_label: scan.time, location_label: scan.location, explicit: false };
  }
  return null;
}

/** Heading info for a line the user forced to be a heading (rules may not match). */
function forcedHeadingInfo(line: string, opts: DetectOptions): HeadingInfo {
  const detected = detectHeading(line, opts);
  if (detected) return detected;
  let t = line.trim();
  const md = MD_HEADING.exec(t);
  if (md) t = md[1]!.trim() || t;
  if (t.startsWith('.') && !t.startsWith('..')) t = t.slice(1).trim() || t;
  const scan = scanTokens(t);
  return { display_no: null, heading: t, time_label: scan.time, location_label: scan.location, explicit: true };
}

// ---------------------------------------------------------------------------
// Fountain title page
// ---------------------------------------------------------------------------

const TITLE_KEY = /^(title|credit|author|authors|source|draft date|date|contact|copyright|notes|revision)\s*:/i;

/** [start, end) 0-based line range of a Fountain title page, or null. */
function titlePageRange(lines: string[]): [number, number] | null {
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (start >= lines.length || !TITLE_KEY.test(lines[start]!.trim())) return null;
  let end = start;
  while (end < lines.length && lines[end]!.trim() !== '') end++;
  return [start, end];
}

// ---------------------------------------------------------------------------
// parseScript
// ---------------------------------------------------------------------------

export function paragraphId(n: number): string {
  return `p-${String(n).padStart(3, '0')}`;
}

type LineRole = 'text' | 'heading' | 'shot';

interface RawParagraph {
  line: number;
  lines: string[];
  heading: HeadingInfo | null;
  shot: ShotLineInfo | null;
}

/** Which scene a shot-list shot without a heading belongs to (table 场次, else 场景/地点). */
function implicitKey(info: ShotLineInfo): string | null {
  return info.scene_key ?? info.location ?? null;
}

function implicitHeading(info: ShotLineInfo, fallback: string): string {
  if (info.location) return [info.location, info.time_label].filter(Boolean).join(' ');
  if (info.scene_key) return `第 ${info.scene_key} 场`;
  return fallback;
}

export function parseScript(
  text: string,
  format: ScriptFormat,
  headingOverrides: readonly HeadingOverrideInput[] = [],
  opts: ParseOptions = {},
): ParsedScriptWithDetection {
  const lines = text.split(/\r\n|\r|\n/);
  const fountainish = format === 'fountain' || format === 'paste';
  const detect: DetectOptions = { forcedDot: fountainish };
  const title = fountainish ? titlePageRange(lines) : null;
  const headingOv = new Map<number, boolean>();
  for (const o of headingOverrides) headingOv.set(o.line, o.is_heading);
  const shotOv = new Map<number, boolean>();
  for (const o of opts.shotOverrides ?? []) shotOv.set(o.line, o.is_shot);

  // 1. what each line is
  const detectedHeadings: number[] = [];
  const detectedShots: number[] = [];
  const roles: { role: LineRole; heading: HeadingInfo | null; shot: ShotLineInfo | null }[] = [];
  let table: ShotTable | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const lineNo = i + 1;
    if (!t) {
      roles.push({ role: 'text', heading: null, shot: null });
      continue;
    }
    const inTitle = title !== null && i >= title[0] && i < title[1];
    let heading: HeadingInfo | null = null;
    let shot: ShotLineInfo | null = null;
    let tableRow = false;
    if (!inTitle) {
      if (table && isTableRule(t)) {
        // markdown rule under the header: plain text
      } else if (table && isTableRow(t, table)) {
        tableRow = true;
        shot = parseTableRow(t, table);
      } else {
        const header = detectShotTable(t);
        table = header;
        if (!header) {
          heading = detectHeading(t, detect);
          if (!heading?.explicit && isShotLine(t, readsLikeHeading)) {
            heading = null;
            shot = parseShotLine(t);
          }
        }
      }
    }
    if (heading) detectedHeadings.push(lineNo);
    if (shot) detectedShots.push(lineNo);

    const forcedHeading = headingOv.get(lineNo);
    const forcedShot = shotOv.get(lineNo);
    let role: LineRole = heading ? 'heading' : shot ? 'shot' : 'text';
    if (forcedShot === true) role = 'shot';
    else if (forcedShot === false && role === 'shot') role = 'text';
    if (forcedHeading === true) role = 'heading';
    else if (forcedHeading === false && role === 'heading') role = 'text';
    if (role === 'heading') heading ??= forcedHeadingInfo(t, detect);
    if (role === 'shot') shot ??= tableRow && table ? parseTableRow(t, table) : parseShotLine(t);
    roles.push({ role, heading: role === 'heading' ? heading : null, shot: role === 'shot' ? shot : null });
  }

  // 2. paragraphs: headings and shots stand alone
  const raw: RawParagraph[] = [];
  let cur: RawParagraph | null = null;
  const flush = () => {
    if (cur) raw.push(cur);
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const r = roles[i]!;
    if (!t) {
      flush();
      continue;
    }
    if (r.role !== 'text') {
      flush();
      raw.push({ line: i + 1, lines: [t], heading: r.heading, shot: r.shot });
      continue;
    }
    if (!cur) cur = { line: i + 1, lines: [], heading: null, shot: null };
    (cur as RawParagraph).lines.push(t);
  }
  flush();

  const headingCount = raw.filter((p) => p.heading).length;
  const shotCount = raw.filter((p) => p.shot).length;
  const kind: ScriptKind = shotCount >= 3 && shotCount >= 2 * headingCount ? 'shot_list' : 'screenplay';

  // 3. scenes
  const paragraphs: Paragraph[] = [];
  const scenes: ParsedScript['scenes'] = [];
  const shotLines: ParsedShotLine[] = [];
  let sceneIdx = -1;
  let implicitAt: string | null | undefined;
  const newScene = (s: Omit<ParsedScript['scenes'][number], 'paragraph_ids'>) => {
    scenes.push({ ...s, paragraph_ids: [] });
    sceneIdx = scenes.length - 1;
  };
  raw.forEach((p, k) => {
    const id = paragraphId(k + 1);
    if (p.heading) {
      newScene({
        display_no: p.heading.display_no ?? String(scenes.length + 1),
        heading: p.heading.heading,
        time_label: p.heading.time_label,
        location_label: p.heading.location_label,
      });
      implicitAt = undefined;
    } else if (p.shot && kind === 'shot_list') {
      const key = headingCount === 0 ? implicitKey(p.shot) : null;
      if (sceneIdx < 0 || (key !== null && implicitAt !== undefined && key !== implicitAt)) {
        newScene({
          display_no: p.shot.scene_key && /^\d+[A-Za-z]?$/.test(p.shot.scene_key) ? p.shot.scene_key : String(scenes.length + 1),
          heading: implicitHeading(p.shot, opts.untitledScene?.trim() || '分镜脚本'),
          time_label: p.shot.time_label,
          location_label: p.shot.location,
        });
      }
      if (headingCount === 0) implicitAt = key;
    }
    if (sceneIdx >= 0) scenes[sceneIdx]!.paragraph_ids.push(id);
    const idx = sceneIdx >= 0 ? sceneIdx : null;
    if (p.shot) shotLines.push({ line: p.line, paragraph_id: id, scene_idx: idx, info: p.shot });
    paragraphs.push({
      id,
      text: p.lines.join('\n'),
      line: p.line,
      is_heading: p.heading !== null,
      scene_idx: idx,
    });
  });

  return { paragraphs, scenes, detected_heading_lines: detectedHeadings, detected_shot_lines: detectedShots, kind, shot_lines: shotLines };
}
