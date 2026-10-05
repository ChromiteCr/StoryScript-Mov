import type { DraftIssue } from '@storyscript/contracts';

/**
 * Variety warnings (S4c). The server's variety check (core analyzeVariety)
 * attaches warnings whose code starts with VARIETY_ to breakdown and polish
 * drafts: runs of the same size / angle / movement, one size dominating, no
 * wide shot, a walking line with a still figure … They are only hints, never
 * errors, so they never block ticking or applying. The drafts show them
 * together under 「镜头变化」 instead of mixed in with the per-shot warnings.
 */

export const VARIETY_PREFIX = 'VARIETY_';
export const VARIETY_TITLE = '镜头变化';

/** Where the person fixes it: the 润色 dialog's 丰富变化 way. */
export const VARIETY_BREAKDOWN_HINT = '这些只是提示，不影响应用。应用后在镜头表里勾选这一场的镜头，点“AI 润色”，方式选“丰富变化”，可以一次调开。';
export const VARIETY_POLISH_HINT = '这些只是提示，不影响应用。想继续调，可以应用后再选这几个镜头，点“AI 润色”，方式选“丰富变化”。';

export function isVarietyIssue(issue: Pick<DraftIssue, 'code'>): boolean {
  return issue.code.startsWith(VARIETY_PREFIX);
}

/** The variety warnings of a draft (whole-draft and per-item alike), and everything else. */
export function splitVariety<T extends Pick<DraftIssue, 'code'>>(issues: readonly T[]): { variety: T[]; rest: T[] } {
  const variety: T[] = [];
  const rest: T[] = [];
  for (const i of issues) (isVarietyIssue(i) ? variety : rest).push(i);
  return { variety, rest };
}

export interface VarietyLine {
  /** "#3" for a warning about one item, null for the whole draft */
  where: string | null;
  message: string;
}

/** Whole-draft warnings first, then per item in item order; an exact repeat is shown once. */
export function varietyLines(issues: readonly DraftIssue[]): VarietyLine[] {
  const lines = issues
    .filter(isVarietyIssue)
    .map((i) => ({ item: i.item, where: i.item === null ? null : `#${i.item + 1}`, message: i.message }))
    .sort((a, b) => (a.item ?? -1) - (b.item ?? -1));
  const seen = new Set<string>();
  const out: VarietyLine[] = [];
  for (const l of lines) {
    const key = `${l.where ?? ''}|${l.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ where: l.where, message: l.message });
  }
  return out;
}
