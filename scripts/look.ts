/**
 * npm run look [-- --out .look]
 *
 * Renders the 12 standard shots (structure + topview) to PNG with resvg-wasm,
 * plus contact sheets for review:
 *   <out>/m1/shots/<key>-structure.png, <key>-topview.png
 *   <out>/m1/compare-1.png, compare-2.png   (structure | topview, 6 shots each)
 *   <out>/m1/compare-structure.png          (all 12 structure boards, 2 × 6)
 *   <out>/m1/compare-topview.png            (all 12 topviews, 2 × 6)
 *   <out>/m1/thumbs.png                     (12 boards at 240 px wide)
 *   <out>/m1/puppets.png                    (6 poses × 4 facings × 3 silhouettes)
 *   <out>/m1/metrics.json                   (framing numbers + timings)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { Pose, Silhouette } from '@storyscript/contracts';
import {
  renderBoard,
  renderPuppetPreview,
  STANDARD_SHOTS,
  standardBoard,
  subjectFramePoints,
  type PuppetView,
} from '../packages/core/src/index.ts';

const { values } = parseArgs({ options: { out: { type: 'string', default: '.look' } } });
const OUT = resolve(values.out ?? '.look', 'm1');
mkdirSync(join(OUT, 'shots'), { recursive: true });

const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
];
const fontBuffers = FONT_CANDIDATES.filter((p) => existsSync(p)).slice(0, 1).map((p) => new Uint8Array(readFileSync(p)));
if (!fontBuffers.length) console.warn('look: no CJK font found, text will not render');

function png(svg: string, width?: number): Buffer {
  const hasText = svg.includes('<text');
  const r = new Resvg(svg, {
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: { fontBuffers: hasText ? fontBuffers : [], defaultFontFamily: 'Hiragino Sans GB', sansSerifFamily: 'Hiragino Sans GB' },
    background: '#ffffff',
  });
  const img = r.render();
  const buf = Buffer.from(img.asPng());
  img.free();
  r.free();
  return buf;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Place a child SVG at (x, y) inside a sheet (rasterised first: resvg drops clip paths in nested <svg>). */
function place(svg: string, x: number, y: number): string {
  const m = /width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  const w = Number(m?.[1] ?? 100);
  const h = Number(m?.[2] ?? 100);
  const data = png(svg, Math.round(w)).toString('base64');
  return `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${data}"/>`;
}
const label = (x: number, y: number, s: string, size = 22) =>
  `<text x="${x}" y="${y}" font-family="Hiragino Sans GB, sans-serif" font-size="${size}" fill="#333333">${esc(s)}</text>`;

const specs = STANDARD_SHOTS.map((s) => ({ shot: s, spec: standardBoard(s) }));
const metrics: Record<string, unknown>[] = [];
const times: number[] = [];

for (const { shot, spec } of specs) {
  const t0 = performance.now();
  const structure = renderBoard(spec, 'structure');
  times.push(performance.now() - t0);
  const topview = renderBoard(spec, 'topview');
  writeFileSync(join(OUT, 'shots', `${shot.key}-structure.svg`), structure);
  writeFileSync(join(OUT, 'shots', `${shot.key}-structure.png`), png(structure, 1840));
  writeFileSync(join(OUT, 'shots', `${shot.key}-topview.png`), png(topview, 1200));
  const pts = subjectFramePoints(spec);
  metrics.push({
    key: shot.key,
    camera: spec.camera,
    subjects: spec.scene.subjects.map((s) => {
      const p = pts.get(s.id);
      return {
        id: s.id,
        x: s.x,
        z: s.z,
        yaw: s.yaw_deg,
        foot: p?.foot?.map((v) => +v.toFixed(3)),
        head: p?.head?.map((v) => +v.toFixed(3)),
        frame_h: p?.foot && p.head ? +(p.foot[1] - p.head[1]).toFixed(3) : null,
      };
    }),
    svg_bytes: Buffer.byteLength(structure),
  });
}

// Compare sheets: structure (1120 wide) | topview (640 wide), 6 rows each.
const SW = 1120;
const TW = 640;
const rowH = Math.round(SW / 2.39) + 44;
for (let page = 0; page < 2; page++) {
  const rows = specs.slice(page * 6, page * 6 + 6);
  const W = SW + TW + 60;
  const H = rows.length * rowH + 20;
  let body = `<rect x="0" y="0" width="${W}" height="${H}" fill="#eeeeee"/>`;
  rows.forEach(({ shot, spec }, i) => {
    const y = 10 + i * rowH;
    body += label(20, y + 28, `${shot.key}  ${shot.name}`);
    body += place(renderBoard(spec, 'structure', { width: SW }), 20, y + 38);
    body += place(renderBoard(spec, 'topview', { width: TW }), SW + 40, y + 38);
  });
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  writeFileSync(join(OUT, `compare-${page + 1}.png`), png(sheet));
}

// One mode per sheet: all 12 shots, 2 columns × 6 rows at 900 px.
for (const mode of ['structure', 'topview'] as const) {
  const cw = 900;
  const chH = Math.round(cw / 2.39);
  const cols = 2;
  const rows = Math.ceil(specs.length / cols);
  const cellH = chH + 44;
  const W = cols * (cw + 20) + 20;
  const H = rows * cellH + 60;
  let body = `<rect x="0" y="0" width="${W}" height="${H}" fill="#eeeeee"/>`;
  body += label(20, 36, mode === 'structure' ? '12 个标准镜头 · 结构图（structure）' : '12 个标准镜头 · 站位俯视图（topview）', 26);
  specs.forEach(({ shot, spec }, i) => {
    const x = 20 + (i % cols) * (cw + 20);
    const y = 50 + Math.floor(i / cols) * cellH;
    body += label(x, y + 28, `${shot.key}  ${shot.name}`);
    body += place(renderBoard(spec, mode, { width: cw }), x, y + 38);
  });
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  writeFileSync(join(OUT, `compare-${mode}.png`), png(sheet));
}

// 240 px thumbnails (readability check).
{
  const tw = 240;
  const th = Math.round(240 / 2.39);
  const cols = 4;
  const W = cols * (tw + 16) + 16;
  const H = 3 * (th + 36) + 16;
  let body = `<rect x="0" y="0" width="${W}" height="${H}" fill="#eeeeee"/>`;
  specs.forEach(({ shot, spec }, i) => {
    const x = 16 + (i % cols) * (tw + 16);
    const y = 16 + Math.floor(i / cols) * (th + 36);
    body += label(x, y + 12, shot.name, 13);
    body += place(renderBoard(spec, 'structure', { width: tw }), x, y + 18);
  });
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  writeFileSync(join(OUT, 'thumbs.png'), png(sheet));
}

// Puppet gallery: rows = poses, columns = silhouettes × facings.
{
  const poses: Pose[] = ['stand', 'walk', 'run', 'sit', 'point', 'crouch'];
  const views: PuppetView[] = ['front', '3q', 'side', 'back'];
  const sils: Silhouette[] = ['regular', 'coat', 'dress'];
  const cw = 110;
  const ch = 190;
  const left = 90;
  const top = 60;
  const W = left + sils.length * (views.length * cw + 20);
  const H = top + poses.length * ch + 10;
  let body = `<rect x="0" y="0" width="${W}" height="${H}" fill="#f4f4f4"/>`;
  sils.forEach((sil, si) => {
    const x0 = left + si * (views.length * cw + 20);
    body += label(x0, 24, sil, 20);
    views.forEach((v, vi) => (body += label(x0 + vi * cw + 30, 48, v, 16)));
  });
  poses.forEach((pose, pi) => {
    const y = top + pi * ch;
    body += label(12, y + ch / 2, pose, 18);
    sils.forEach((sil, si) => {
      const x0 = left + si * (views.length * cw + 20);
      views.forEach((v, vi) => {
        body += place(renderPuppetPreview(pose, v, false, sil, { width: cw, height: ch }), x0 + vi * cw, y);
      });
    });
  });
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  writeFileSync(join(OUT, 'puppets.png'), png(sheet));
  // Small version: the same sheet at 40 % (figures ≈ 64 px tall).
  writeFileSync(join(OUT, 'puppets-small.png'), png(sheet, Math.round(W * 0.4)));
}

const avg = times.reduce((a, b) => a + b, 0) / times.length;
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ structure_ms_avg: +avg.toFixed(2), shots: metrics }, null, 2));
console.log(`look: wrote ${OUT} (structure avg ${avg.toFixed(1)} ms)`);
