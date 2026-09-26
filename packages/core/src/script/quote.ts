/**
 * Quote verification (SPEC FR-03 step 4). A model-supplied quote is compared
 * with the paragraph it claims to come from:
 *   exact    — after normalisation the quote is a substring of the paragraph
 *   fuzzy    — best-matching substring is within 15% edits of the quote length
 *   rejected — anything else (cannot be applied)
 * Normalisation: NFKC, full-width/half-width punctuation unified, whitespace
 * and zero-width characters removed, runs of dots folded into one ellipsis.
 */

export type QuoteLevel = 'exact' | 'fuzzy' | 'rejected';

export interface QuoteMatchResult {
  level: QuoteLevel;
  /** minimal edit distance to any substring of the paragraph (0 for exact) */
  distance: number;
  /** normalised quote length in code points */
  length: number;
}

export const FUZZY_RATIO = 0.15;

/** Punctuation NFKC leaves alone, mapped to one canonical form each. */
const PUNCT: Record<string, string> = {
  '。': '.',
  '｡': '.',
  '、': ',',
  '“': '"',
  '”': '"',
  '„': '"',
  '「': '"',
  '」': '"',
  '『': '"',
  '』': '"',
  '〝': '"',
  '〞': '"',
  '‘': "'",
  '’': "'",
  '《': '<',
  '〈': '<',
  '》': '>',
  '〉': '>',
  '【': '[',
  '〔': '[',
  '】': ']',
  '〕': ']',
  '—': '-',
  '–': '-',
  '―': '-',
  '‐': '-',
  '−': '-',
  '～': '~',
  '〜': '~',
  '・': '·',
  '•': '·',
  '⋯': '...',
};

const PUNCT_RE = new RegExp(`[${Object.keys(PUNCT).join('')}]`, 'g');

export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(PUNCT_RE, (ch) => PUNCT[ch] ?? ch)
    .replace(/[\s​-‍⁠﻿]+/g, '')
    .replace(/\.{2,}/g, '…')
    .replace(/…+/g, '…')
    .replace(/-{2,}/g, '-');
}

/**
 * Minimal edit distance between `pattern` and any substring of `text`
 * (Sellers' approximate substring matching; free start and end in text).
 */
export function substringEditDistance(pattern: readonly string[], text: readonly string[]): number {
  const m = pattern.length;
  if (m === 0) return 0;
  if (text.length === 0) return m;
  // column over pattern positions, iterate text characters
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best = prev[m]!;
  for (let j = 1; j <= text.length; j++) {
    cur[0] = 0;
    const tc = text[j - 1];
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1]! + (pattern[i - 1] === tc ? 0 : 1);
      const del = prev[i]! + 1;
      const ins = cur[i - 1]! + 1;
      cur[i] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    if (cur[m]! < best) best = cur[m]!;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return best;
}

/** Normalised equality/substring test used by relink ("exact" only). */
export function quoteIsExact(quote: string, paragraphText: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(paragraphText).includes(q);
}

export function matchQuote(quote: string, paragraphText: string): QuoteMatchResult {
  const q = normalizeForMatch(quote);
  const qc = Array.from(q);
  if (qc.length === 0) return { level: 'rejected', distance: 0, length: 0 };
  const p = normalizeForMatch(paragraphText);
  if (p.includes(q)) return { level: 'exact', distance: 0, length: qc.length };
  const distance = substringEditDistance(qc, Array.from(p));
  const limit = Math.floor(qc.length * FUZZY_RATIO);
  return { level: distance <= limit && distance > 0 ? 'fuzzy' : 'rejected', distance, length: qc.length };
}
