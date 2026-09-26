/**
 * Pencil look parameters ("宽银幕铅笔分镜"). One code path, many looks: the
 * three review variants (checkpoint C1b) differ only in these numbers.
 *
 * Units are viewBox px of the 1840-wide frame. Tone 0 = paper, 3 = darkest.
 */
import type { LookPreset } from '@storyscript/contracts';
import { LOOK_WIDE_PENCIL } from '../presets/techniques.ts';

type Four = readonly [number, number, number, number];
type Three = readonly [number, number, number];

export interface PencilLook {
  /** hatch direction (deg, counter-clockwise from screen-right) — LookPreset.pencil.hatch_angle_deg */
  angle: number;
  /** T3 cross-hatch direction (deg) */
  cross: number;
  /** paper tone as authored (may be tinted); rendered as its neutral grey (same luminance) */
  paperTone: string;
  /** base contour width w₀ per depth band (px @ 1840) — LookPreset.pencil.outline_px */
  outline: { fg: number; mg: number; bg: number };
  hatch: {
    /** line spacing of T1 / T2 / T3 */
    spacing: Three;
    /** max lens width of a hatch stroke */
    width: Three;
    /** fill-opacity of T1 / T2 / T3 strokes */
    opacity: Three;
    /** grey level of the graphite per group (0 = black): light pressure for T1, heavier for T3 */
    ink: Three;
    /** lines per hand patch (adjacent strokes laid in one sweep share breaks, bow and pressure) */
    patchMin: number;
    patchMax: number;
    /** ± px jitter of each stroke's ends around its patch's breaks */
    endJitter: number;
    /** ± slant of a patch's break line across the patch (px per line) */
    slant: number;
    segMin: number;
    segMax: number;
    gapMin: number;
    gapMax: number;
    /** bow sagitta as a fraction of the stroke length */
    bow: number;
    /** ± relative jitter of width and opacity */
    jitter: number;
    /** ± angle jitter (deg) */
    wobble: number;
  };
  /** σ of the blurred tone masks */
  maskBlur: number;
  /** blurred graphite smudge under T3 */
  smudge: { blur: number; opacity: number; ink: number };
  /** flat tone darkness (multiply on paper, 0..1) for sets, props and ground, per tone */
  fill: Four;
  /** flat darkness of figure silhouettes per tone (figures read as solid shapes) */
  figure: Four;
  /** figure shade darkness: this far from the lit tone to the next darker tone */
  shade: number;
  /** tone steps (0..1) the hatch masks take off a figure's lit side (its fill keeps the full tone) */
  litHatch: number;
  contour: {
    /** multiplier on outline w₀ */
    scale: number;
    ink: number;
    opacity: number;
    /** second pass: relative width, px offset, opacity, wobble (px) */
    second: number;
    offset: number;
    secondOpacity: number;
    secondWobble: number;
    /** end overshoot as a fraction of the stroke length */
    overshoot: number;
    /** probability of dropping a stroke on the lit side */
    litBreak: number;
    /** width factor on the lit side (the strokes left after the breaks) */
    lit: number;
    /** width factor on the shadow side */
    shade: number;
  };
  construction: { stroke: string; opacity: number; width: number };
  /** paper grain strength multiplier (0 = off) */
  grain: number;
  /** paper tooth: paper-coloured specks over the graphite (fill-opacity, 0 = off) */
  tooth: number;
  /** vignette darkness at the corners (0..1) */
  vignette: number;
}

export type PencilVariant = 'A' | 'B' | 'C';

const BASE: PencilLook = {
  angle: LOOK_WIDE_PENCIL.pencil.hatch_angle_deg,
  cross: 108,
  paperTone: LOOK_WIDE_PENCIL.pencil.paper_tone,
  outline: { ...LOOK_WIDE_PENCIL.pencil.outline_px },
  hatch: {
    spacing: [9, 6, 7],
    width: [1.6, 1.5, 1.5],
    opacity: [0.72, 0.78, 0.8],
    ink: [64, 48, 30],
    patchMin: 5,
    patchMax: 12,
    endJitter: 3,
    slant: 1.6,
    segMin: 40,
    segMax: 120,
    gapMin: 2,
    gapMax: 6,
    bow: 0.018,
    jitter: 0.15,
    wobble: 1.2,
  },
  maskBlur: 1.2,
  smudge: { blur: 2, opacity: 0.5, ink: 48 },
  fill: [0, 0.2, 0.34, 0.5],
  figure: [0.06, 0.26, 0.44, 0.82],
  shade: 0.6,
  litHatch: 0.5,
  contour: {
    scale: 1,
    ink: 28,
    opacity: 0.88,
    second: 0.6,
    offset: 1,
    secondOpacity: 0.5,
    secondWobble: 0.9,
    overshoot: 0.03,
    litBreak: 0.15,
    lit: 0.7,
    shade: 1.5,
  },
  construction: { stroke: '#8a8a8a', opacity: 0.35, width: 0.6 },
  grain: 1,
  tooth: 0.5,
  vignette: 0.12,
};

/** The three C1b candidates. A: hatch-led. B: tone-block-led. C: line-led. */
export const PENCIL_VARIANTS: Record<PencilVariant, PencilLook> = {
  A: BASE,
  // B: flat graphite blocks carry the values, the hatch is only a faint texture over them
  B: {
    ...BASE,
    hatch: { ...BASE.hatch, opacity: [0.22, 0.25, 0.3] },
    smudge: { ...BASE.smudge, opacity: 0.35 },
    fill: [0, 0.26, 0.46, 0.66],
    figure: [0.08, 0.34, 0.56, 0.86],
  },
  // C: heavier, more varied contours; values held light so the line leads
  C: {
    ...BASE,
    hatch: { ...BASE.hatch, opacity: [0.46, 0.5, 0.56], width: [1.4, 1.3, 1.3] },
    smudge: { ...BASE.smudge, opacity: 0.3 },
    fill: [0, 0.12, 0.22, 0.36],
    figure: [0.05, 0.2, 0.34, 0.62],
    contour: { ...BASE.contour, scale: 1.75, lit: 0.6, shade: 1.6 },
  },
};

export const DEFAULT_PENCIL_VARIANT: PencilVariant = 'A';
export const DEFAULT_PENCIL_LOOK: PencilLook = PENCIL_VARIANTS[DEFAULT_PENCIL_VARIANT];

/** Look for a preset + optional variant / overrides (preset fields win over the variant's). */
export function resolvePencilLook(
  opts: { preset?: LookPreset['pencil'] | null; variant?: PencilVariant | null; overrides?: Partial<PencilLook> | null } = {},
): PencilLook {
  const base = PENCIL_VARIANTS[opts.variant ?? DEFAULT_PENCIL_VARIANT];
  const p = opts.preset;
  const withPreset: PencilLook = p
    ? { ...base, angle: p.hatch_angle_deg, paperTone: p.paper_tone, outline: { ...p.outline_px } }
    : base;
  return opts.overrides ? { ...withPreset, ...opts.overrides } : withPreset;
}

/**
 * Neutral grey (0..255) with the luminance of a #rrggbb tone. The renderer only
 * emits greys (saturation 0, look metric L2), so a tinted paper tone is kept
 * as its luminance; any tint belongs to the display layer.
 */
export function paperLevel(tone: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(tone.trim());
  if (!m) return 240;
  const r = parseInt(m[1] as string, 16);
  const g = parseInt(m[2] as string, 16);
  const b = parseInt(m[3] as string, 16);
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}
