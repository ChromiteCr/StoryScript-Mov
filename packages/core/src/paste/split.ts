import { PASTE_MAX_CHARS, PASTE_SEGMENT_CHARS } from '@storyscript/contracts';

/**
 * S5a 粘贴整理 — the pasted text is cleaned once (line ends, trailing spaces,
 * surrounding blank lines) and cut into segments of at most 3000 characters
 * at line breaks, so a message is never split unless one line alone is
 * longer than a segment. Each segment is one model job.
 */

export interface PasteSegment {
  /** offsets into the cleaned text, [start, end) */
  start: number;
  end: number;
  text: string;
}

export function cleanPasteText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t　]+$/u, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

export function splitPaste(clean: string, max: number = PASTE_SEGMENT_CHARS): PasteSegment[] {
  const text = clean.slice(0, PASTE_MAX_CHARS);
  const out: PasteSegment[] = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    const piece = text.slice(start, end).replace(/\n+$/, '');
    if (piece.trim()) out.push({ start, end: start + piece.length, text: piece });
  };
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl < 0 ? text.length : nl + 1;
    if (lineEnd - at > max) {
      // one line longer than a segment: close what we have, then cut the line hard
      if (end > start) flush();
      for (let s = at; s < lineEnd; s += max) {
        start = s;
        end = Math.min(lineEnd, s + max);
        flush();
      }
      start = end = lineEnd;
    } else if (lineEnd - start > max) {
      flush();
      start = at;
      end = lineEnd;
    } else {
      end = lineEnd;
    }
    at = lineEnd;
  }
  if (end > start) flush();
  return out;
}
