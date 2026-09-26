/**
 * Flags concrete film-fact claims in model output (titles in 《》, years,
 * timecodes, "in the film ..."). Annotate only — never block: scripts
 * legitimately contain book titles and years (SPEC FR-05, AT-06).
 */
export interface ClaimFlag {
  kind: 'title' | 'year' | 'timecode' | 'film_reference';
  text: string;
}

const PATTERNS: { kind: ClaimFlag['kind']; re: RegExp }[] = [
  { kind: 'title', re: /《[^》]{1,40}》/g },
  { kind: 'year', re: /(?<!\d)(19[0-9]{2}|20[0-9]{2})\s*年/g },
  { kind: 'timecode', re: /\b\d{1,2}:\d{2}:\d{2}(?::\d{2})?\b/g },
  { kind: 'film_reference', re: /(在|于)(电影|影片)[^，。；]{0,20}(中|里)/g },
];

export function flagFilmClaims(text: string): ClaimFlag[] {
  const out: ClaimFlag[] = [];
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) out.push({ kind, text: m[0] });
  }
  return out;
}

/**
 * Image-prompt trigger filter: strips person names / titles / trademarks the
 * user may have typed into free text before it reaches an image model.
 * Applied to image prompts only, never to the breakdown stage.
 */
const TRIGGER_TERMS = [
  'imax',
  'nolan',
  'christopher nolan',
  '诺兰',
  '克里斯托弗',
  '诺兰式',
  '诺兰风',
];

export function stripTriggerTerms(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text;
  // longest first so "诺兰式" is removed whole instead of leaving "式"
  for (const term of [...TRIGGER_TERMS].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(out)) {
      removed.push(term);
      out = out.replace(re, '');
    }
  }
  out = out.replace(/《[^》]{1,40}》/g, (m) => {
    removed.push(m);
    return '';
  });
  return { text: out.replace(/\s{2,}/g, ' ').trim(), removed };
}
