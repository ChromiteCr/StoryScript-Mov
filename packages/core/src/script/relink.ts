import { normalizeForMatch } from './quote.ts';

/**
 * Carry shots over to a new script version (SPEC FR-02). A shot keeps its
 * anchor only when its old quote is found verbatim (after normalisation) in a
 * paragraph of the new version; everything else is flagged needs_relink.
 * Line numbers and paragraph ids are never used to guess a match.
 *
 * When the quote occurs in several paragraphs, the paragraph with the same id
 * wins; otherwise the match is ambiguous and the shot needs a human relink.
 */

export interface RelinkShotInput {
  id: string;
  source_anchor: { paragraph_id: string; quote: string } | null;
}

export interface RelinkResult {
  kept: { shot_id: string; paragraph_id: string }[];
  needs_relink: string[];
  /** shots without an anchor (manual shots may have none); left untouched */
  unanchored: string[];
}

export function relinkShots(
  oldShots: readonly RelinkShotInput[],
  newParagraphs: readonly { id: string; text: string }[],
): RelinkResult {
  const normalized = newParagraphs.map((p) => ({ id: p.id, text: normalizeForMatch(p.text) }));
  const out: RelinkResult = { kept: [], needs_relink: [], unanchored: [] };
  for (const shot of oldShots) {
    const anchor = shot.source_anchor;
    if (!anchor) {
      out.unanchored.push(shot.id);
      continue;
    }
    const q = normalizeForMatch(anchor.quote);
    if (!q) {
      out.needs_relink.push(shot.id);
      continue;
    }
    const hits = normalized.filter((p) => p.text.includes(q));
    const same = hits.find((p) => p.id === anchor.paragraph_id);
    const chosen = same ?? (hits.length === 1 ? hits[0] : undefined);
    if (chosen) out.kept.push({ shot_id: shot.id, paragraph_id: chosen.id });
    else out.needs_relink.push(shot.id);
  }
  return out;
}
