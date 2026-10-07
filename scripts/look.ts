/**
 * npm run look [-- --out .look] [--only m1|m2] [--fast]
 *
 * Renders the 12 standard shots to PNG with resvg-wasm, plus review sheets.
 *
 * M1 (structure / topview):
 *   <out>/m1/shots/<key>-structure.png, <key>-topview.png
 *   <out>/m1/compare-1.png, compare-2.png   (structure | topview, 6 shots each)
 *   <out>/m1/compare-structure.png          (all 12 structure boards, 2 × 6)
 *   <out>/m1/compare-topview.png            (all 12 topviews, 2 × 6)
 *   <out>/m1/thumbs.png                     (12 boards at 240 px wide)
 *   <out>/m1/puppets.png                    (10 poses × 4 facings × 3 silhouettes)
 *   <out>/m1/gestures.png                   (S4c: the gesture variants of stand / sit / walk)
 *   <out>/m1/metrics.json                   (framing numbers + timings)
 *
 * M2 (pencil):
 *   <out>/m2/shots/<key>-pencil.svg / .png  (1840 px, annotation layer on)
 *   <out>/m2/compare-1.png, compare-2.png   (structure | pencil, 6 shots each)
 *   <out>/m2/compare-pencil.png             (all 12 pencil boards, 2 × 6)
 *   <out>/m2/compare-variety.png            (S4c: the variety shots — places, props, poses; structure | pencil)
 *   <out>/m2/expressions.png                (S5b: 7 emotions × front / three-quarter, close-up and medium shot)
 *   <out>/m2/objects.png                    (S5b: a named tin on a table at five angles, a bottle, a named prop beside a person)
 *   <out>/m2/thumbs.png                     (12 pencil boards at 240 px wide)
 *   <out>/m2/crop-1.png, crop-2.png         (1:1 crops, re-rendered from a viewBox sub-rect)
 *   <out>/m2/metrics.json, metrics.md, metrics.png  (look metrics L1–L7 + timings)
 *   <out>/m2/variant-A.png / -B / -C        (C1b candidates: the same 6 shots per look variant)
 *
 * --fast skips the metrics and the variant pages.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-wasm';
import { Emotion, Pose, type BoardSpec, type ShotFields, type Silhouette } from '@storyscript/contracts';
import { initResvg, svgToPixels } from '../apps/server/src/adapters/render/resvg.ts';
import {
  DEFAULT_PENCIL_VARIANT,
  gestureCount,
  LOOK_THRESHOLDS,
  measureLook,
  PENCIL_VARIANTS,
  renderBoard,
  renderPuppetPreview,
  STANDARD_SHOTS,
  standardBoard,
  structureHash,
  VARIETY_SHOTS,
  subjectFrameBoxes,
  subjectFramePoints,
  type LookReport,
  type PencilLook,
  type PencilVariant,
  type PuppetView,
  layoutBoard,
  ZH_EMOTION,
} from '../packages/core/src/index.ts';
import { shotFields, STANDARD_LOOK, STANDARD_ROSTER, subject } from '../packages/core/src/board/fixtures/standard-shots.ts';


const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.look' },
    only: { type: 'string' },
    fast: { type: 'boolean', default: false },
  },
});
const ROOT = resolve(values.out ?? '.look');
const doM1 = !values.only || values.only === 'm1';
const doM2 = !values.only || values.only === 'm2';

await initResvg();

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
const label = (x: number, y: number, s: string, size = 22, fill = '#333333') =>
  `<text x="${x}" y="${y}" font-family="Hiragino Sans GB, sans-serif" font-size="${size}" fill="${fill}">${esc(s)}</text>`;
const sheetSvg = (W: number, H: number, body: string, bg = '#eeeeee') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`;

const specs = STANDARD_SHOTS.map((s, i) => ({ shot: s, spec: standardBoard(s), code: `S01-${String(i + 1).padStart(3, '0')}` }));

// ---------------------------------------------------------------------------
// M1: structure / topview / puppets
// ---------------------------------------------------------------------------

function m1(): void {
  const OUT = join(ROOT, 'm1');
  mkdirSync(join(OUT, 'shots'), { recursive: true });
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
    let body = '';
    rows.forEach(({ shot, spec }, i) => {
      const y = 10 + i * rowH;
      body += label(20, y + 28, `${shot.key}  ${shot.name}`);
      body += place(renderBoard(spec, 'structure', { width: SW }), 20, y + 38);
      body += place(renderBoard(spec, 'topview', { width: TW }), SW + 40, y + 38);
    });
    writeFileSync(join(OUT, `compare-${page + 1}.png`), png(sheetSvg(W, H, body)));
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
    let body = label(20, 36, mode === 'structure' ? '12 个标准镜头 · 结构图（structure）' : '12 个标准镜头 · 站位俯视图（topview）', 26);
    specs.forEach(({ shot, spec }, i) => {
      const x = 20 + (i % cols) * (cw + 20);
      const y = 50 + Math.floor(i / cols) * cellH;
      body += label(x, y + 28, `${shot.key}  ${shot.name}`);
      body += place(renderBoard(spec, mode, { width: cw }), x, y + 38);
    });
    writeFileSync(join(OUT, `compare-${mode}.png`), png(sheetSvg(W, H, body)));
  }

  writeFileSync(join(OUT, 'thumbs.png'), thumbSheet('structure'));

  // Puppet gallery: rows = poses, columns = silhouettes × facings.
  {
    const poses: Pose[] = [...Pose.options];
    const views: PuppetView[] = ['front', '3q', 'side', 'back'];
    const sils: Silhouette[] = ['regular', 'coat', 'dress'];
    const cw = 110;
    const ch = 190;
    const left = 90;
    const top = 60;
    const W = left + sils.length * (views.length * cw + 20);
    const H = top + poses.length * ch + 10;
    let body = '';
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
    const sheet = sheetSvg(W, H, body, '#f4f4f4');
    writeFileSync(join(OUT, 'puppets.png'), png(sheet));
    // Small version: the same sheet at 40 % (figures ≈ 64 px tall).
    writeFileSync(join(OUT, 'puppets-small.png'), png(sheet, Math.round(W * 0.4)));
  }

  // S4c gesture variants: one row per pose with variants, front and 3/4
  {
    const rows: Pose[] = ['stand', 'sit', 'walk'];
    const cw = 110;
    const ch = 190;
    const cols = Math.max(...rows.map((p) => gestureCount(p))) * 2;
    const W = 90 + cols * cw;
    const H = 30 + rows.length * ch;
    let body = '';
    rows.forEach((pose, ri) => {
      const y = 20 + ri * ch;
      body += label(12, y + ch / 2, pose, 18);
      for (let g = 0; g < gestureCount(pose); g++)
        (['front', '3q'] as const).forEach((v, vi) => {
          body += place(renderPuppetPreview(pose, v, false, 'regular', { width: cw, height: ch, gesture: g }), 90 + (g * 2 + vi) * cw, y);
        });
    });
    writeFileSync(join(OUT, 'gestures.png'), png(sheetSvg(W, H, body, '#f4f4f4')));
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ structure_ms_avg: +avg.toFixed(2), shots: metrics }, null, 2));
  console.log(`look: wrote ${OUT} (structure avg ${avg.toFixed(1)} ms)`);
}

/** 240 px thumbnails (readability check), 4 × 3. */
function thumbSheet(mode: 'structure' | 'pencil'): Buffer {
  const tw = 240;
  const th = Math.round(240 / 2.39);
  const cols = 4;
  const W = cols * (tw + 16) + 16;
  const H = 3 * (th + 36) + 16;
  let body = '';
  specs.forEach(({ shot, spec }, i) => {
    const x = 16 + (i % cols) * (tw + 16);
    const y = 16 + Math.floor(i / cols) * (th + 36);
    body += label(x, y + 12, shot.name, 13);
    body += place(renderBoard(spec, mode, { width: tw }), x, y + 18);
  });
  return png(sheetSvg(W, H, body));
}

// ---------------------------------------------------------------------------
// M2: pencil
// ---------------------------------------------------------------------------

const pencil = (spec: BoardSpec, o: { width?: number; overlay?: boolean; code?: string; look?: PencilLook } = {}) =>
  renderBoard(spec, 'pencil', { width: o.width, overlay: o.overlay, code: o.code ?? null, pencil: { look: o.look } });

/** Re-render a sub-rectangle of the 1840-wide frame at 1:1 by rewriting the root viewBox. */
function cropSvg(svg: string, x: number, y: number, w: number, h: number): string {
  return svg.replace(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]*" width="[^"]*" height="[^"]*">/, () => {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`;
  });
}

const raster = (svg: string, width: number) => svgToPixels(svg, { width, background: '#ffffff' });

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const f2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));

/** Per-metric verdict for one board ('skip' where a metric does not apply). */
function verdicts(r: LookReport): Record<string, 'pass' | 'FAIL' | 'skip'> {
  const T = LOOK_THRESHOLDS;
  const v = (ok: boolean) => (ok ? 'pass' : 'FAIL');
  return {
    L1: v(r.l1.pass),
    L2: v(r.l2 <= T.l2.maxSaturation),
    L3: r.l3 && r.l3Area >= 150 ? v(r.l3.iou >= T.l3.minIoU) : 'skip',
    L4: r.bands.length >= 2 ? v(r.l4.pass) : 'skip',
    L5: v(r.l5.pass),
    L6: r.l6 !== null ? v(r.l6 <= T.l6.maxShare) : 'skip',
    L7: v(r.l7.cv >= T.l7.minCV),
  };
}

async function m2(): Promise<void> {
  const OUT = join(ROOT, 'm2');
  mkdirSync(join(OUT, 'shots'), { recursive: true });
  const timing: { key: string; gen_ms: number; png_ms: number; paths: number; kb: number; hash: string }[] = [];

  for (const { shot, spec, code } of specs) {
    pencil(spec); // warm-up
    const t0 = performance.now();
    const rounds = 3;
    for (let r = 0; r < rounds; r++) pencil(spec, { overlay: false });
    const gen = (performance.now() - t0) / rounds;
    const clean = pencil(spec, { overlay: false });
    const t1 = performance.now();
    await svgToPixels(clean, { width: 1840 });
    const pngMs = performance.now() - t1;
    const svg = pencil(spec, { code });
    writeFileSync(join(OUT, 'shots', `${shot.key}-pencil.svg`), svg);
    writeFileSync(join(OUT, 'shots', `${shot.key}-pencil.png`), png(svg, 1840));
    timing.push({
      key: shot.key,
      gen_ms: +gen.toFixed(1),
      png_ms: +pngMs.toFixed(0),
      paths: (clean.match(/<path/g) ?? []).length,
      kb: Math.round(Buffer.byteLength(clean) / 1024),
      hash: structureHash(spec),
    });
  }

  // structure | pencil, 6 rows per page
  const CW = 900;
  const rowH = Math.round(CW / 2.39) + 46;
  for (let page = 0; page < 2; page++) {
    const rows = specs.slice(page * 6, page * 6 + 6);
    const W = 2 * CW + 60;
    const H = rows.length * rowH + 20;
    let body = '';
    rows.forEach(({ shot, spec, code }, i) => {
      const y = 10 + i * rowH;
      body += label(20, y + 28, `${shot.key}  ${shot.name}  · structure`);
      body += label(CW + 40, y + 28, 'pencil');
      body += place(renderBoard(spec, 'structure', { width: CW }), 20, y + 38);
      body += place(pencil(spec, { width: CW, code }), CW + 40, y + 38);
    });
    writeFileSync(join(OUT, `compare-${page + 1}.png`), png(sheetSvg(W, H, body)));
  }

  // all 12 pencil boards, 2 × 6
  {
    const cols = 2;
    const cellH = Math.round(CW / 2.39) + 44;
    const W = cols * (CW + 20) + 20;
    const H = Math.ceil(specs.length / cols) * cellH + 60;
    let body = label(20, 36, '12 个标准镜头 · 铅笔稿（pencil）', 26);
    specs.forEach(({ shot, spec, code }, i) => {
      const x = 20 + (i % cols) * (CW + 20);
      const y = 50 + Math.floor(i / cols) * cellH;
      body += label(x, y + 28, `${shot.key}  ${shot.name}`);
      body += place(pencil(spec, { width: CW, code }), x, y + 38);
    });
    writeFileSync(join(OUT, 'compare-pencil.png'), png(sheetSvg(W, H, body)));
  }

  writeFileSync(join(OUT, 'thumbs.png'), thumbSheet('pencil'));

  // S4c variety shots: structure | pencil per row
  {
    const vspecs = VARIETY_SHOTS.map((s, i) => ({ shot: s, spec: standardBoard(s), code: `V01-${String(i + 1).padStart(3, '0')}` }));
    const rowH = Math.round(CW / 2.39) + 46;
    const W = 2 * CW + 60;
    const H = vspecs.length * rowH + 20;
    let body = '';
    vspecs.forEach(({ shot, spec, code }, i) => {
      const y = 10 + i * rowH;
      body += label(20, y + 28, `${shot.key}  ${shot.name}  · structure`);
      body += label(CW + 40, y + 28, 'pencil');
      body += place(renderBoard(spec, 'structure', { width: CW }), 20, y + 38);
      body += place(pencil(spec, { width: CW, code }), CW + 40, y + 38);
    });
    writeFileSync(join(OUT, 'compare-variety.png'), png(sheetSvg(W, H, body)));
  }

  // S5b: the seven feelings, face (CU) and body (MS), front and three-quarter
  {
    const cw = 440;
    const chH = Math.round(cw / 2.39);
    const cols: { size: 'CU' | 'MS'; facing: 'camera' | '3q_left' }[] = [
      { size: 'CU', facing: 'camera' },
      { size: 'CU', facing: '3q_left' },
      { size: 'MS', facing: 'camera' },
      { size: 'MS', facing: '3q_left' },
    ];
    const left = 110;
    const W = left + cols.length * (cw + 10) + 10;
    const H = 50 + Emotion.options.length * (chH + 12);
    let body = label(20, 34, 'S5b 人物情绪 · 特写与中景，正面与四分之三侧面（铅笔稿）', 24);
    Emotion.options.forEach((e, row) => {
      const y = 50 + row * (chH + 12);
      body += label(20, y + chH / 2 + 8, ZH_EMOTION[e], 22);
      cols.forEach((c, ci) => {
        const fields = shotFields({ shot_size: c.size, env: 'interior', subjects: [subject(c.size === 'MS' ? 'c3' : 'c2', { facing: c.facing, emotion: e })] });
        const spec = layoutBoard(fields, { scene_sides: null, roster: STANDARD_ROSTER, look: STANDARD_LOOK, technique: null, aspect: '2.39', seed: 7 });
        body += place(renderBoard(spec, 'pencil', { width: cw, overlay: false }), left + ci * (cw + 10), y);
      });
    });
    writeFileSync(join(OUT, 'expressions.png'), png(sheetSvg(W, H, body)));
  }

  // S5b: an object a close-up can only draw as a shape, named on the board
  {
    const cw = 900;
    const chH = Math.round(cw / 2.39);
    const shots: { name: string; f: Partial<ShotFields> }[] = [
      { name: '插入 平视', f: { angle: 'eye' } },
      { name: '插入 俯拍', f: { angle: 'high' } },
      { name: '插入 顶拍', f: { angle: 'overhead' } },
      { name: '插入 仰拍', f: { angle: 'low' } },
      { name: '大特写 斜角', f: { shot_size: 'ECU', angle: 'dutch' } },
      { name: '插入 药瓶（夜）', f: { props: ['table', 'bottle'], object_name: '药瓶' } },
      { name: '中景 人物与桌上的罐头', f: { template: null, shot_size: 'MS', subjects: [subject('c2', { pose: 'sit', facing: '3q_right' })] } },
      { name: '插入 没有名称', f: { object_name: null } },
    ];
    const W = 30 + 2 * cw;
    const H = 50 + Math.ceil(shots.length / 2) * (chH + 44);
    let body = label(20, 34, 'S5b 物件名称 · 水果罐头的不同角度（铅笔稿）', 24);
    shots.forEach((s, i) => {
      const x = 10 + (i % 2) * (cw + 10);
      const y = 50 + Math.floor(i / 2) * (chH + 44);
      const fields = shotFields({ template: 'insert', shot_size: 'INSERT', env: 'interior', props: ['table', 'can'], object_name: '水果罐头', action: '桌上的水果罐头', ...s.f });
      const spec = layoutBoard(fields, { scene_sides: null, roster: STANDARD_ROSTER, look: STANDARD_LOOK, technique: null, aspect: '2.39', seed: 11 + i, time_label: s.name.includes('夜') ? '夜' : null });
      body += label(x, y + 28, s.name);
      body += place(renderBoard(spec, 'pencil', { width: cw, code: `O-${i + 1}` }), x, y + 38);
    });
    writeFileSync(join(OUT, 'objects.png'), png(sheetSvg(W, H, body)));
  }

  // 1:1 crops: the OTS listener's head and shoulders; the group around the table
  const crops: { key: string; subject: string; w: number; h: number; fy: number }[] = [
    { key: '03-ots-a', subject: 's1', w: 900, h: 560, fy: 0.02 },
    { key: '12-group', subject: 's1', w: 900, h: 560, fy: 0.35 },
  ];
  crops.forEach((c, i) => {
    const e = specs.find((s) => s.shot.key === c.key);
    if (!e) return;
    const box = subjectFrameBoxes(e.spec).get(c.subject);
    const W = 1840;
    const H = box?.H ?? W / 2.39;
    const cx = box ? (Math.max(0, box.x0) + Math.min(W, box.x1)) / 2 : W / 2;
    const top = box ? Math.max(0, box.y0) + c.fy * (Math.min(H, box.y1) - Math.max(0, box.y0)) - 60 : 0;
    const x = Math.round(Math.min(Math.max(0, cx - c.w / 2), W - c.w));
    const y = Math.round(Math.min(Math.max(0, top), H - c.h));
    const svg = cropSvg(pencil(e.spec, { overlay: false }), x, y, c.w, Math.min(c.h, Math.floor(H)));
    writeFileSync(join(OUT, `crop-${i + 1}.png`), png(svg));
  });

  if (values.fast) {
    writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ timing }, null, 2));
    console.log(`look: wrote ${OUT} (fast: no metrics / variants)`);
    printTiming(timing);
    return;
  }

  // look metrics
  const reports: { key: string; r: LookReport; v: Record<string, string> }[] = [];
  for (const { shot, spec } of specs) {
    const r = await measureLook(spec, raster);
    reports.push({ key: shot.key, r, v: verdicts(r) });
  }
  const md: string[] = [
    `# pencil look metrics (variant ${DEFAULT_PENCIL_VARIANT})`,
    '',
    '| shot | L1 clusters | L2 sat | L3 IoU | L4 fg/mg/bg | L5 peak·share | L6 fg paper | L7 CV | gen ms | png ms | paths |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const { key, r, v } of reports) {
    const t = timing.find((x) => x.key === key);
    const m = r.l4.means;
    md.push(
      `| ${key} | ${r.l1.distinct} [${r.l1.centers.map((c, i) => `${c.toFixed(2)}·${pct(r.l1.shares[i] ?? 0)}`).join(' ')}] ${v.L1} ` +
        `| ${r.l2.toFixed(3)} ${v.L2} | ${r.l3 ? r.l3.iou.toFixed(2) : '—'} (${r.l3Area}px) ${v.L3} ` +
        `| ${f2(m.fg)}/${f2(m.mg)}/${f2(m.bg)} ${v.L4} | ${r.l5.peak}°·${pct(r.l5.share)} ${v.L5} ` +
        `| ${r.l6 === null ? '—' : pct(r.l6)} ${v.L6} | ${r.l7.cv.toFixed(2)} ${v.L7} | ${t?.gen_ms} | ${t?.png_ms} | ${t?.paths} |`,
    );
  }
  writeFileSync(join(OUT, 'metrics.md'), `${md.join('\n')}\n`);
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ timing, reports }, null, 2));
  writeFileSync(join(OUT, 'metrics.png'), metricsSheet(reports.map(({ key, r, v }) => ({ key, r, v, t: timing.find((x) => x.key === key) }))));
  console.log(md.join('\n'));
  printTiming(timing);

  // C1b variant pages: the same 6 shots under each look
  const pick = ['01-ews-scale', '03-ots-a', '05-mcu', '07-chase', '10-depth-two', '12-group'];
  const names: Record<PencilVariant, string> = { A: '排线主导', B: '色块主导', C: '线条主导' };
  for (const v of ['A', 'B', 'C'] as const) {
    const look = PENCIL_VARIANTS[v];
    const cols = 2;
    const cellH = Math.round(CW / 2.39) + 44;
    const W = cols * (CW + 20) + 20;
    const H = Math.ceil(pick.length / cols) * cellH + 60;
    let body = label(20, 36, `变体 ${v} · ${names[v]}${v === DEFAULT_PENCIL_VARIANT ? '（默认）' : ''}`, 26);
    pick.forEach((key, i) => {
      const e = specs.find((s) => s.shot.key === key);
      if (!e) return;
      const x = 20 + (i % cols) * (CW + 20);
      const y = 50 + Math.floor(i / cols) * cellH;
      body += label(x, y + 28, `${e.shot.key}  ${e.shot.name}`);
      body += place(pencil(e.spec, { width: CW, code: e.code, look }), x, y + 38);
    });
    writeFileSync(join(OUT, `variant-${v}.png`), png(sheetSvg(W, H, body)));
    const vr: string[] = [];
    for (const key of pick) {
      const e = specs.find((s) => s.shot.key === key);
      if (!e) continue;
      const r = await measureLook(e.spec, raster, { look });
      const fails = Object.entries(verdicts(r)).filter(([, x]) => x === 'FAIL').map(([k]) => k);
      vr.push(`${key}: ${fails.length ? `FAIL ${fails.join(',')}` : 'all pass'}`);
    }
    console.log(`variant ${v}: ${vr.join(' | ')}`);
  }
  console.log(`look: wrote ${OUT}`);
}

function printTiming(timing: { key: string; gen_ms: number; png_ms: number; paths: number; kb: number }[]): void {
  const g = Math.max(...timing.map((t) => t.gen_ms));
  const p = Math.max(...timing.map((t) => t.png_ms));
  console.log(`pencil: max gen ${g} ms, max png ${p} ms, paths ${timing.map((t) => t.paths).join('/')}, kB ${timing.map((t) => t.kb).join('/')}`);
}

function metricsSheet(rows: { key: string; r: LookReport; v: Record<string, string>; t?: { gen_ms: number; png_ms: number } }[]): Buffer {
  const cols = ['shot', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'gen', 'png'];
  const xs = [16, 190, 330, 450, 590, 820, 990, 1110, 1220, 1320];
  const rowH = 30;
  const W = 1420;
  const H = 70 + rows.length * rowH;
  let body = cols.map((c, i) => label(xs[i] as number, 40, c, 18)).join('');
  rows.forEach(({ key, r, v, t }, i) => {
    const y = 72 + i * rowH;
    const cell = (k: number, s: string, verdict?: string) =>
      label(xs[k] as number, y, s, 16, verdict === 'FAIL' ? '#000000' : verdict === 'skip' ? '#999999' : '#333333') +
      (verdict === 'FAIL' ? `<rect x="${(xs[k] as number) - 4}" y="${y - 18}" width="${(xs[k + 1] ?? W) - (xs[k] as number) - 6}" height="24" fill="none" stroke="#000000" stroke-width="2"/>` : '');
    const m = r.l4.means;
    body += cell(0, key);
    body += cell(1, `${r.l1.distinct} cl`, v.L1);
    body += cell(2, r.l2.toFixed(3), v.L2);
    body += cell(3, r.l3 ? r.l3.iou.toFixed(2) : '—', v.L3);
    body += cell(4, `${f2(m.fg)}/${f2(m.mg)}/${f2(m.bg)}`, v.L4);
    body += cell(5, `${r.l5.peak}° ${pct(r.l5.share)}`, v.L5);
    body += cell(6, r.l6 === null ? '—' : pct(r.l6), v.L6);
    body += cell(7, r.l7.cv.toFixed(2), v.L7);
    body += cell(8, `${t?.gen_ms ?? '—'}`);
    body += cell(9, `${t?.png_ms ?? '—'}`);
  });
  return png(sheetSvg(W, H, body, '#ffffff'));
}

if (doM1) m1();
if (doM2) await m2();
