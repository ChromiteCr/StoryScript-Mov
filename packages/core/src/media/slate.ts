/**
 * Slate codes (FR-06 slate cards, FR-09 rule R1).
 *
 * A format is literal text with placeholders `{scene}`, `{shot}`, `{take}`,
 * each optionally zero-padded: `{scene:02}`. Default: "S{scene:02}-{shot:03}-T{take:02}".
 * Parsing is lenient on purpose: case-insensitive, and any run of
 * `-`, `_`, `.` or spaces matches any separator in the format, so
 * "s01_003_t02" and "S01 003 T02" both read as scene 1, shot 3, take 2.
 */

export const DEFAULT_SLATE_FORMAT = 'S{scene:02}-{shot:03}-T{take:02}';

export interface SlateCode {
  scene: number;
  shot: number;
  take: number | null;
}

type Token =
  | { kind: 'lit'; text: string }
  | { kind: 'sep'; text: string }
  | { kind: 'field'; name: 'scene' | 'shot' | 'take'; width: number };

export type SlateFormatResult = { ok: true; tokens: Token[] } | { ok: false; message: string };

const SEPARATORS = new Set(['-', '_', '.', ' ']);

export function compileSlateFormat(format: string): SlateFormatResult {
  const tokens: Token[] = [];
  const seen = new Set<string>();
  const re = /\{(\w+)(?::(\d{1,2}))?\}|[^{}]/g;
  let pos = 0;
  for (const m of format.matchAll(re)) {
    if (m.index !== pos) return { ok: false, message: `unexpected "${format.slice(pos, m.index)}" in slate format` };
    pos = m.index + m[0].length;
    if (m[1] !== undefined) {
      const name = m[1];
      if (name !== 'scene' && name !== 'shot' && name !== 'take') return { ok: false, message: `unknown placeholder {${name}}` };
      if (seen.has(name)) return { ok: false, message: `placeholder {${name}} appears twice` };
      seen.add(name);
      tokens.push({ kind: 'field', name, width: m[2] ? Number(m[2]) : 0 });
    } else if (SEPARATORS.has(m[0])) {
      const last = tokens[tokens.length - 1];
      if (last?.kind === 'sep') last.text += m[0];
      else tokens.push({ kind: 'sep', text: m[0] });
    } else {
      const last = tokens[tokens.length - 1];
      if (last?.kind === 'lit') last.text += m[0];
      else tokens.push({ kind: 'lit', text: m[0] });
    }
  }
  if (pos !== format.length) return { ok: false, message: `unbalanced braces in slate format "${format}"` };
  if (!seen.has('scene') || !seen.has('shot')) return { ok: false, message: 'slate format needs {scene} and {shot}' };
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i]!.kind === 'field' && tokens[i - 1]!.kind === 'field') {
      return { ok: false, message: 'two placeholders must be separated by text or a separator' };
    }
  }
  return { ok: true, tokens };
}

/** Renders a slate code, e.g. formatSlate(DEFAULT_SLATE_FORMAT, {scene:1, shot:3, take:2}) → "S01-003-T02". */
export function formatSlate(format: string, code: { scene: number; shot: number; take?: number | null }): string {
  const compiled = compileSlateFormat(format);
  if (!compiled.ok) throw new RangeError(compiled.message);
  let out = '';
  for (const t of compiled.tokens) {
    if (t.kind !== 'field') out += t.text;
    else {
      const v = t.name === 'take' ? code.take : code[t.name];
      if (v === null || v === undefined) throw new RangeError(`slate value {${t.name}} is missing`);
      if (!Number.isInteger(v) || v < 0) throw new RangeError(`slate value {${t.name}} must be a non-negative integer`);
      out += String(v).padStart(t.width, '0');
    }
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source that finds a slate code anywhere in a file name (null for a bad format). */
export function slateRegexSource(format: string): string | null {
  const compiled = compileSlateFormat(format);
  if (!compiled.ok) return null;
  const parts = compiled.tokens.map((t) =>
    t.kind === 'lit' ? escapeRe(t.text) : t.kind === 'sep' ? '[-_. ]+' : `(?<${t.name}>\\d{1,6})`,
  );
  const first = compiled.tokens[0]!;
  const last = compiled.tokens[compiled.tokens.length - 1]!;
  // do not start or end inside a longer alphanumeric run
  const lead = first.kind === 'field' ? '(?<![0-9])' : first.kind === 'lit' && /^[a-z0-9]/i.test(first.text) ? '(?<![a-z0-9])' : '';
  const trail = last.kind === 'field' ? '(?![0-9])' : last.kind === 'lit' && /[a-z0-9]$/i.test(last.text) ? '(?![a-z0-9])' : '';
  return `${lead}${parts.join('')}${trail}`;
}

/** Finds the first slate code in `text` (e.g. a file name); null when none or the format is invalid. */
export function parseSlate(format: string, text: string): SlateCode | null {
  const source = slateRegexSource(format);
  if (source === null) return null;
  const m = new RegExp(source, 'i').exec(text);
  if (!m?.groups) return null;
  const num = (s: string | undefined): number | null => (s === undefined ? null : Number.parseInt(s, 10));
  const scene = num(m.groups.scene);
  const shot = num(m.groups.shot);
  if (scene === null || shot === null) return null;
  return { scene, shot, take: num(m.groups.take) };
}
