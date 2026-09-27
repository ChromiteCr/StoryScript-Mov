import { mulberry32 } from '@storyscript/core';
import { beforeAll, describe, expect, test } from 'vitest';
import { initResvg, svgToPixels, svgToPng } from '../src/adapters/render/resvg.ts';
import { budget } from '../../../packages/core/test/perf-budget.ts';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Pencil-like stress SVG: ~2000 stroked/filled paths on a 2.39:1 frame.
 * `groupOpacity` uses the `opacity` attribute (one offscreen layer per path,
 * ~3-4x slower in resvg) instead of stroke-/fill-opacity: the worst case.
 */
function stressSvg(paths = 2000, seed = 7, groupOpacity = true): string {
  const op = (v: number, paint: 'fill' | 'stroke') =>
    groupOpacity ? `opacity="${v.toFixed(2)}"` : `${paint}-opacity="${v.toFixed(2)}"`;
  const rnd = mulberry32(seed);
  const W = 1840;
  const H = 770;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#F3F0E8"/>`,
  ];
  for (let i = 0; i < paths; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const len = 40 + rnd() * 80;
    const a = (38 * Math.PI) / 180;
    const bow = (rnd() - 0.5) * 6;
    const x2 = x + Math.cos(a) * len;
    const y2 = y - Math.sin(a) * len;
    const mx = (x + x2) / 2 + bow;
    const my = (y + y2) / 2 + bow;
    const gray = Math.round(40 + rnd() * 80);
    if (i % 5 === 0) {
      // tapered outline as a filled polygon
      parts.push(
        `<path d="M${x.toFixed(2)} ${y.toFixed(2)}Q${mx.toFixed(2)} ${my.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}` +
          `L${(x2 + 1.5).toFixed(2)} ${(y2 + 1.5).toFixed(2)}Q${(mx + 2).toFixed(2)} ${(my + 2).toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}Z" ` +
          `fill="rgb(${gray},${gray},${gray})" ${op(0.6 + rnd() * 0.3, 'fill')}/>`,
      );
    } else {
      parts.push(
        `<path d="M${x.toFixed(2)} ${y.toFixed(2)}Q${mx.toFixed(2)} ${my.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}" ` +
          `fill="none" stroke="rgb(${gray},${gray},${gray})" stroke-width="${(0.8 + rnd() * 1.2).toFixed(2)}" ` +
          `stroke-linecap="round" ${op(0.4 + rnd() * 0.4, 'stroke')}/>`,
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

describe('resvg-wasm adapter', () => {
  beforeAll(async () => {
    await initResvg();
  });

  test('initResvg is idempotent', async () => {
    await Promise.all([initResvg(), initResvg()]);
  });

  test('same SVG renders byte-identical PNGs', async () => {
    const svg = stressSvg(300, 1);
    const a = await svgToPng(svg, { width: 920 });
    const b = await svgToPng(svg, { width: 920 });
    expect([...a.slice(0, 8)]).toEqual(PNG_MAGIC);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('1840px wide, ~2000 paths renders < 1.5s', async () => {
    const svg = stressSvg(2000, 7);
    await svgToPng(svg, { width: 1840 }); // warm-up (wasm JIT)
    const t0 = performance.now();
    const png = await svgToPng(svg, { width: 1840 });
    const ms = performance.now() - t0;
    expect(png.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(budget(1500));
  });

  test('svgToPixels returns straight RGBA at the requested width', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="239" height="100" viewBox="0 0 239 100">' +
      '<rect width="239" height="100" fill="#F3F0E8"/><rect x="10" y="10" width="50" height="50" fill="#000000" opacity="0.5"/></svg>';
    const px = await svgToPixels(svg, { width: 478 });
    expect(px.width).toBe(478);
    expect(px.height).toBe(200);
    expect(px.rgba.length).toBe(478 * 200 * 4);
    expect([...px.rgba.slice(0, 4)]).toEqual([0xf3, 0xf0, 0xe8, 255]);
    const i = (70 * 478 + 70) * 4; // inside the 50% black square
    expect(px.rgba[i + 3]).toBe(255);
    expect(Math.abs(px.rgba[i]! - 0x7a)).toBeLessThanOrEqual(1);

    // semi-transparent pixels are un-premultiplied (tiny-skia stores premultiplied)
    const t = await svgToPixels(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000" opacity="0.5"/></svg>',
      { width: 4 },
    );
    expect([...t.rgba.slice(0, 4)]).toEqual([255, 0, 0, 128]);
  });

  test('<text> without loaded fonts does not crash (text is just not drawn)', async () => {
    const withText =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
      '<rect width="200" height="100" fill="#ffffff"/><text x="10" y="50" font-size="30" fill="#000000">S01-003 镜头</text></svg>';
    const blank =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#ffffff"/></svg>';
    const a = await svgToPixels(withText, { width: 200 });
    const b = await svgToPixels(blank, { width: 200 });
    expect(a.width).toBe(200);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
  });

  test('malformed SVG and bad width throw instead of crashing', async () => {
    await expect(svgToPng('<svg', { width: 100 })).rejects.toThrow();
    await expect(svgToPng('<svg xmlns="http://www.w3.org/2000/svg"/>', { width: 0 })).rejects.toThrow(RangeError);
  });

  test('50 consecutive renders do not grow RSS linearly (handles are freed)', async () => {
    const svg = stressSvg(2000, 11, false);
    for (let i = 0; i < 5; i++) await svgToPixels(svg, { width: 1840 }); // let the wasm heap reach steady state
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 50; i++) {
      if (i % 2) await svgToPng(svg, { width: 1840 });
      else await svgToPixels(svg, { width: 1840 });
    }
    const growthMb = (process.memoryUsage().rss - before) / 1024 / 1024;
    // a leaked 1840x770 RGBA frame is ~5.4 MiB; 50 leaks would be ~270 MiB
    expect(growthMb).toBeLessThan(100);
  }, 120_000);
});
