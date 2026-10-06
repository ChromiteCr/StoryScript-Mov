/**
 * Pencil look metrics L1–L7 (docs/PLAN.md "画风可测指标") on the 12 standard
 * shots, rasterised with the server's resvg adapter. The metric functions are
 * pure (packages/core/src/board/look-metrics.ts); this file feeds them pixels.
 *
 * Where a metric does not apply to a shot the skip is explicit (see `applies`).
 */
import {
  DEFAULT_PENCIL_LOOK,
  l1ToneClusters,
  l2MaxSaturation,
  l5HatchDirection,
  l7LineWidthCV,
  LOOK_THRESHOLDS as T,
  luminance,
  measureLook,
  renderBoard,
  STANDARD_SHOTS,
  standardBoard,
  type LookReport,
  type Mask,
  type StandardShot,
  type RgbaImage,
} from '@storyscript/core';
import { beforeAll, describe, expect, test } from 'vitest';
import { initResvg, svgToPixels, svgToPng } from '../src/adapters/render/resvg.ts';
import { budget } from '../../../packages/core/test/perf-budget.ts';

const raster = (svg: string, width: number) => svgToPixels(svg, { width, background: '#ffffff' });

/** L3 needs a person big enough to have a silhouette at 240 px (≥ 150 px of it). */
const MIN_THUMB_AREA = 150;

const applies = {
  // 11-insert has nobody in frame; 01-ews-scale's person is a ~10 px speck at
  // 240 px by design (the scale shot) — nothing to binarise. An extreme
  // close-up (06-ecu) is a face filling the frame: since S4c faces are drawn
  // light, it reads by its features and hair, not as a dark silhouette.
  l3: (r: LookReport, shot: StandardShot) => r.l3 !== null && r.l3Area >= MIN_THUMB_AREA && shot.fields.shot_size !== 'ECU',
  // depth ordering needs people in at least two depth bands (03/04 OTS, 10 depth)
  l4: (r: LookReport) => r.bands.length >= 2,
  // no people: no foreground subject (11-insert)
  l6: (r: LookReport) => r.l6 !== null,
};

describe('look metrics L1–L7 on the 12 standard shots (default look)', () => {
  const reports = new Map<string, LookReport>();

  beforeAll(async () => {
    await initResvg();
    for (const shot of STANDARD_SHOTS) reports.set(shot.key, await measureLook(standardBoard(shot), raster, { look: DEFAULT_PENCIL_LOOK }));
  }, 240_000);

  const get = (key: string): LookReport => {
    const r = reports.get(key);
    if (!r) throw new Error(`no report for ${key}`);
    return r;
  };

  for (const shot of STANDARD_SHOTS) {
    describe(shot.key, () => {
      test('L1 ≥3 luminance clusters of ≥3 %, ≥0.15 apart', () => {
        const r = get(shot.key).l1;
        expect(r.distinct, `${r.centers.map((c) => c.toFixed(2))} / ${r.shares.map((s) => s.toFixed(3))}`).toBeGreaterThanOrEqual(T.l1.minClusters);
      });

      test('L2 max saturation ≤ 0.04', () => {
        expect(get(shot.key).l2).toBeLessThanOrEqual(T.l2.maxSaturation);
      });

      test('L3 thumbnail silhouette IoU ≥ 0.7', (ctx) => {
        const r = get(shot.key);
        if (!applies.l3(r, shot)) ctx.skip();
        expect(r.l3?.iou).toBeGreaterThanOrEqual(T.l3.minIoU);
      });

      test('L4 people: foreground < mid-ground < background, gaps ≥ 0.08', (ctx) => {
        const r = get(shot.key);
        if (!applies.l4(r)) ctx.skip();
        expect(r.l4.pass, JSON.stringify(r.l4.means)).toBe(true);
        expect(r.l4.minGap).toBeGreaterThanOrEqual(T.l4.minGap);
      });

      test('L5 hatch direction: peak at 38° ± 8°, ≥ 50 % of the gradient energy', () => {
        const r = get(shot.key).l5;
        expect(Math.min(Math.abs(r.peak - 38), 180 - Math.abs(r.peak - 38))).toBeLessThanOrEqual(T.l5.tolerance);
        expect(r.share).toBeGreaterThanOrEqual(T.l5.minShare);
      });

      test('L6 foreground subject: ≤ 40 % near-paper pixels inside', (ctx) => {
        const r = get(shot.key);
        if (!applies.l6(r)) ctx.skip();
        expect(r.l6).toBeLessThanOrEqual(T.l6.maxShare);
      });

      test('L7 contour width coefficient of variation ≥ 0.25', () => {
        expect(get(shot.key).l7.cv).toBeGreaterThanOrEqual(T.l7.minCV);
      });
    });
  }

  test('skips are only the documented ones', () => {
    const skipped = (f: (r: LookReport, shot: StandardShot) => boolean) => STANDARD_SHOTS.filter((s) => !f(get(s.key), s)).map((s) => s.key);
    expect(skipped(applies.l3)).toEqual(['01-ews-scale', '06-ecu', '11-insert']);
    expect(skipped(applies.l6)).toEqual(['11-insert']);
    expect(STANDARD_SHOTS.filter((s) => applies.l4(get(s.key))).map((s) => s.key)).toEqual(['03-ots-a', '04-ots-b', '10-depth-two']);
  });
});

// ---------------------------------------------------------------------------
// the metrics themselves, on synthetic images
// ---------------------------------------------------------------------------

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number]): RgbaImage {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      rgba.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, rgba };
}
const grey = (v: number): [number, number, number] => [v, v, v];

describe('look metric functions', () => {
  test('L1: four tone bands pass, paper + one grey fails', () => {
    const bands = image(200, 50, (x) => grey([240, 180, 110, 40][Math.floor(x / 50)] as number));
    expect(l1ToneClusters(luminance(bands)).distinct).toBeGreaterThanOrEqual(3);
    const two = image(200, 50, (x) => grey(x < 150 ? 240 : 200));
    expect(l1ToneClusters(luminance(two)).pass).toBe(false);
  });

  test('L1: k-means is not trapped on a paper-dominated frame (vignette + one two-tone figure)', () => {
    const img = image(400, 100, (x, y) => {
      if (x >= 150 && x < 250) return grey(x < 215 ? 130 : 50);
      return grey(Math.round(236 - 14 * Math.hypot((x - 200) / 200, (y - 50) / 50)));
    });
    const r = l1ToneClusters(luminance(img));
    expect(r.pass, r.centers.map((c) => c.toFixed(2)).join(' ')).toBe(true);
  });

  test('L2: greys are 0, a tint is caught', () => {
    expect(l2MaxSaturation(image(10, 10, () => grey(120)))).toBe(0);
    expect(l2MaxSaturation(image(10, 10, (x) => (x === 3 ? [200, 180, 160] : grey(200))))).toBeGreaterThan(0.04);
  });

  test('L5: 38° stripes vote for 38°, 108° stripes do not', () => {
    const W = 200;
    const H = 200;
    const all: Mask = { width: W, height: H, data: new Uint8Array(W * H).fill(1) };
    const stripes = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      // stripes run along (cos a, −sin a) in screen space (y down)
      return image(W, H, (x, y) => grey(Math.sin((x * Math.sin(a) + y * Math.cos(a)) * ((2 * Math.PI) / 8)) > 0.4 ? 40 : 235));
    };
    const r38 = l5HatchDirection(luminance(stripes(38)), W, H, all, 38);
    expect(Math.abs(r38.peak - 38)).toBeLessThanOrEqual(3);
    expect(r38.pass).toBe(true);
    expect(l5HatchDirection(luminance(stripes(108)), W, H, all, 38).pass).toBe(false);
  });

  test('L7: strokes of mixed weight vary, strokes of one weight do not', () => {
    const W = 300;
    const H = 120;
    const uniform = image(W, H, (_x, y) => grey(y % 30 >= 14 && y % 30 < 17 ? 20 : 255));
    const mixed = image(W, H, (_x, y) => {
      const w = [2, 5, 9, 3][Math.floor(y / 30)] as number;
      return grey(Math.abs((y % 30) - 15) < w / 2 ? 20 : 255);
    });
    expect(l7LineWidthCV(luminance(uniform), W, H).cv).toBeLessThan(0.1);
    expect(l7LineWidthCV(luminance(mixed), W, H).cv).toBeGreaterThanOrEqual(T.l7.minCV);
  });
});

// ---------------------------------------------------------------------------
// performance: resvg PNG at 1840 px
// ---------------------------------------------------------------------------

describe('pencil rasterisation performance', () => {
  test('every standard board renders to a 1840 px PNG in < 1.5 s', async () => {
    await initResvg();
    const slow: string[] = [];
    for (const shot of STANDARD_SHOTS) {
      const svg = renderBoard(standardBoard(shot), 'pencil', { overlay: false });
      // best of two: the budget is the renderer's cost, not a noisy neighbour's
      let best = Infinity;
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        const png = await svgToPng(svg, { width: 1840 });
        best = Math.min(best, performance.now() - t0);
        expect(png.length).toBeGreaterThan(1000);
      }
      if (best >= budget(1500)) slow.push(`${shot.key} ${best.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);
});
