import type { Paragraph, ParsedScript, ScriptFormat } from '@storyscript/contracts';

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
 */

export interface HeadingOverrideInput {
  /** 1-based raw line number */
  line: number;
  is_heading: boolean;
}

export interface ParsedScriptWithDetection extends ParsedScript {
  /** 1-based line numbers the rules detected as scene headings (before overrides) */
  detected_heading_lines: number[];
}

export interface HeadingInfo {
  /** explicit scene number written in the heading, if any */
  display_no: string | null;
  /** heading text without the scene number */
  heading: string;
  time_label: string | null;
  location_label: string | null;
}

// ---------------------------------------------------------------------------
// token classification
// ---------------------------------------------------------------------------

const IE_TOKEN = /^(内景|外景|内外景|内\/外景?|外\/内景?|内|外|INT\.?|EXT\.?|INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E|E\/I)$/i;
/** strong interior/exterior words: enough on their own for a bare heading */
const IE_STRONG = /^(内景|外景|内外景|内\/外景|外\/内景|INT\.?|EXT\.?)$/i;
const TIME_TOKEN =
  /^(日|夜|晨|昏|黄昏|傍晚|清晨|早晨|早上|上午|中午|午后|下午|晚上|夜晚|深夜|凌晨|黎明|白天|日景|夜景|DAY|NIGHT|MORNING|EVENING|DUSK|DAWN|AFTERNOON|CONTINUOUS|LATER|MOMENTS LATER|SAME)$/i;
/** "日内" / "夜外": time and interior/exterior glued together */
const TIME_IE_TOKEN = /^(日|夜)(内|外)$/;

const TOKEN_SPLIT = /[\s·•・|｜，,]+|[-–—]+/;
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
// numerals
// ---------------------------------------------------------------------------

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** "12" / "１２" / "十二" / "一百零五" → number; null when not a numeral. */
export function parseSceneNumeral(s: string): number | null {
  const ascii = s.normalize('NFKC');
  if (/^\d+$/.test(ascii)) return parseInt(ascii, 10);
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    const d = CN_DIGITS[ch];
    if (d !== undefined) {
      cur = d;
      seen = true;
    } else if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
      seen = true;
    } else if (ch === '百') {
      total += (cur || 1) * 100;
      cur = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + cur : null;
}

// ---------------------------------------------------------------------------
// heading detection
// ---------------------------------------------------------------------------

const MD_HEADING = /^#{1,6}\s+(.*)$/;
const FOUNTAIN_SCENE_NO = /\s*#([A-Za-z0-9.\-]+)#\s*$/;
const FOUNTAIN_PREFIX = /^(INT\.?\/EXT|EXT\.?\/INT|INT\/EXT|EXT\/INT|I\/E|E\/I|INT|EXT|EST)(?:\.|\s)\s*(.*)$/i;
const FOUNTAIN_FORCED = /^\.(?![.\s])(.+)$/;
const CN_DI_CHANG = /^第\s*([0-9０-９一二三四五六七八九十百零〇两]+)\s*场(?:\s+|[：:.、．]\s*|$)(.*)$/;
const CN_CHANG = /^场景?\s*([0-9０-９]+[A-Za-z]?)(?:\s+|[：:.、．]\s*|$)(.*)$/;
const CN_NUMBERED = /^([0-9０-９]+[A-Za-z]?)\s*(?:[.、．:：)）]\s*|\s+)(.+)$/;

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

function chineseInfo(no: string | null, rest: string, fallback: string): HeadingInfo {
  const scan = scanTokens(rest);
  const heading = rest.trim() || fallback;
  return { display_no: no, heading, time_label: scan.time, location_label: scan.location };
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
      return { display_no: sceneNo, heading, time_label: parts.time, location_label: parts.location };
    }
  }

  const fountain = FOUNTAIN_PREFIX.exec(t);
  if (fountain) {
    const parts = fountainParts(fountain[2] ?? '');
    return { display_no: sceneNo, heading: t, time_label: parts.time, location_label: parts.location };
  }
  if (sceneNo !== null) return null; // "#1#" alone does not make a heading

  const di = CN_DI_CHANG.exec(t);
  if (di) return chineseInfo(numberString(di[1]!), di[2] ?? '', t);

  const chang = CN_CHANG.exec(t);
  if (chang) return chineseInfo(numberString(chang[1]!), chang[2] ?? '', t);

  if (t.length > 60 || SENTENCE_END.test(t)) return null;

  const numbered = CN_NUMBERED.exec(t);
  if (numbered) {
    const rest = numbered[2]!.trim();
    const scan = scanTokens(rest);
    if (scan.ie || scan.time) return chineseInfo(numberString(numbered[1]!), rest, t);
    return null;
  }

  if (t.length > 40) return null;
  const scan = scanTokens(t);
  if ((scan.ie && scan.time) || (scan.strongIe && scan.count >= 2)) {
    return { display_no: null, heading: t, time_label: scan.time, location_label: scan.location };
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
  return { display_no: null, heading: t, time_label: scan.time, location_label: scan.location };
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

interface RawParagraph {
  line: number;
  lines: string[];
  heading: HeadingInfo | null;
}

export function parseScript(
  text: string,
  format: ScriptFormat,
  headingOverrides: readonly HeadingOverrideInput[] = [],
): ParsedScriptWithDetection {
  const lines = text.split(/\r\n|\r|\n/);
  const fountainish = format === 'fountain' || format === 'paste';
  const opts: DetectOptions = { forcedDot: fountainish };
  const title = fountainish ? titlePageRange(lines) : null;
  const overrides = new Map<number, boolean>();
  for (const o of headingOverrides) overrides.set(o.line, o.is_heading);

  const raw: RawParagraph[] = [];
  const detected: number[] = [];
  let cur: RawParagraph | null = null;
  const flush = () => {
    if (cur) raw.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) {
      flush();
      continue;
    }
    const lineNo = i + 1;
    const inTitle = title !== null && i >= title[0] && i < title[1];
    const info = inTitle ? null : detectHeading(t, opts);
    if (info) detected.push(lineNo);
    const forced = overrides.get(lineNo);
    const isHeading = forced !== undefined ? forced : info !== null;
    if (isHeading) {
      flush();
      raw.push({ line: lineNo, lines: [t], heading: info ?? forcedHeadingInfo(t, opts) });
      continue;
    }
    if (!cur) cur = { line: lineNo, lines: [], heading: null };
    (cur as RawParagraph).lines.push(t);
  }
  flush();

  const paragraphs: Paragraph[] = [];
  const scenes: ParsedScript['scenes'] = [];
  let sceneIdx = -1;
  raw.forEach((p, k) => {
    const id = paragraphId(k + 1);
    if (p.heading) {
      sceneIdx++;
      scenes.push({
        display_no: p.heading.display_no ?? String(sceneIdx + 1),
        heading: p.heading.heading,
        paragraph_ids: [id],
        time_label: p.heading.time_label,
        location_label: p.heading.location_label,
      });
    } else if (sceneIdx >= 0) {
      scenes[sceneIdx]!.paragraph_ids.push(id);
    }
    paragraphs.push({
      id,
      text: p.lines.join('\n'),
      line: p.line,
      is_heading: p.heading !== null,
      scene_idx: sceneIdx >= 0 ? sceneIdx : null,
    });
  });

  return { paragraphs, scenes, detected_heading_lines: detected };
}
