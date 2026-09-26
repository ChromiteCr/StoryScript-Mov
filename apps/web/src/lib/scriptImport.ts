import type { HeadingOverride, ScriptFormat } from '@storyscript/contracts';

/**
 * Pure helpers for the script import panel (FR-02). No DOM.
 * Line numbers are 1-based raw line numbers, matching HeadingOverride.line
 * and ScriptPreview.detected_heading_lines.
 */

/** Contract cap (ScriptInput.text max). */
export const MAX_SCRIPT_CHARS = 2_000_000;

export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.fountain'] as const;
export const ACCEPT_ATTR = '.txt,.md,.markdown,.fountain,text/plain,text/markdown';

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function isAcceptedFileName(name: string): boolean {
  const ext = extensionOf(name);
  return ext === '.txt' || ext === '.md' || ext === '.markdown' || ext === '.fountain';
}

export function formatFromFileName(name: string): ScriptFormat {
  const ext = extensionOf(name);
  if (ext === '.fountain') return 'fountain';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return 'txt';
}

export type LineSet = ReadonlySet<number> | readonly number[];

function has(set: LineSet, line: number): boolean {
  return set instanceof Set ? set.has(line) : (set as readonly number[]).includes(line);
}

/** Whether a line currently counts as a scene heading: an override wins over the rule result. */
export function isHeadingLine(line: number, detected: LineSet, overrides: readonly HeadingOverride[]): boolean {
  const o = overrides.find((x) => x.line === line);
  if (o) return o.is_heading;
  return has(detected, line);
}

/**
 * Flip one line. The result keeps only overrides that differ from what the
 * rules detected, so toggling twice returns to "no override" and the list
 * sent to the server stays minimal. Sorted by line.
 */
export function toggleHeadingOverride(
  overrides: readonly HeadingOverride[],
  detected: LineSet,
  line: number,
): HeadingOverride[] {
  const current = isHeadingLine(line, detected, overrides);
  const next = !current;
  const detectedHere = has(detected, line);
  const rest = overrides.filter((o) => o.line !== line);
  if (next !== detectedHere) rest.push({ line, is_heading: next });
  return rest.sort((a, b) => a.line - b.line);
}

/** Drop overrides that point past the end of the text or at blank lines. */
export function pruneOverrides(overrides: readonly HeadingOverride[], lines: readonly string[]): HeadingOverride[] {
  return overrides.filter((o) => o.line >= 1 && o.line <= lines.length && (lines[o.line - 1] ?? '').trim() !== '');
}

/** A source name for pasted text, e.g. "粘贴的剧本 2026-09-26 14:05". */
export function pastedSourceName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `粘贴的剧本 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
