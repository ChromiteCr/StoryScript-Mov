/**
 * Character look (S4c): hair style and clothing values per character, from a
 * hash of the character's identity — entity_id, else the label — so the same
 * person wears the same clothes and hair in every frame, and two characters
 * are told apart at a glance. Pure; no randomness beyond the hash.
 */
import type { Silhouette } from '@storyscript/contracts';
import { cyrb53 } from '../util/hash.ts';

export const HAIR_STYLES = ['short', 'crop', 'side', 'long', 'ponytail', 'bun'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

/** Clothing value: light / mid / dark cloth (greys only). */
export type ClothShade = 'light' | 'mid' | 'dark';
const SHADES: readonly ClothShade[] = ['light', 'mid', 'dark'];

export interface FigureStyle {
  hair: HairStyle;
  top: ClothShade;
  bottom: ClothShade;
}

/** Figures with no identity (gallery previews, tests). */
export const DEFAULT_FIGURE_STYLE: FigureStyle = { hair: 'short', top: 'mid', bottom: 'dark' };

/** Tone offset (0..3 tone steps) a cloth value adds to the figure's depth-band tone. */
export const CLOTH_OFFSET: Record<ClothShade, number> = { light: -0.5, mid: 0, dark: 0.5 };

/** Dress silhouettes lean toward long hair, a ponytail or a bun (7 in 8). */
const DRESS_HAIR: readonly HairStyle[] = ['long', 'ponytail', 'bun'];

export function figureStyleFor(s: { entity_id?: string | null; label?: string | null; silhouette: Silhouette }): FigureStyle {
  const key = s.entity_id ?? s.label ?? '';
  const h = cyrb53(`figure-style:${key}`);
  // independent digits of the hash (h < 2^53)
  const digit = (k: number, n: number) => Math.floor(h / 8 ** k) % n;
  let hair: HairStyle;
  if (s.silhouette === 'dress' && digit(0, 8) !== 0) hair = DRESS_HAIR[digit(1, DRESS_HAIR.length)] as HairStyle;
  else hair = HAIR_STYLES[digit(2, HAIR_STYLES.length)] as HairStyle;
  const top = SHADES[digit(3, 3)] as ClothShade;
  const rest = SHADES.filter((x) => x !== top);
  const bottom = rest[digit(4, 2)] as ClothShade;
  return { hair, top, bottom };
}
