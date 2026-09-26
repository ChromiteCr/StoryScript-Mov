/**
 * SVG builders for the AI pencil redraw (SPEC FR-12, experimental). Pure
 * string functions; the server rasterises the results with resvg.
 *
 *  - padControlSvg: the text-free board render (renderBoard(…, {overlay:false}))
 *    placed on a canvas of the ratio the image service will return, on plain
 *    paper margins (contain-fit, centred — core/prompt/image planCanvas).
 *  - rasterPostSvg: deterministic post-processing of a returned image —
 *    desaturate (feColorMatrix), compress the levels into the pencil range
 *    (feComponentTransfer), crop back to the recorded frame box, and lay the
 *    same paper grain and vignette the pencil renderer uses (core/board/paper).
 *
 * Presentation attributes only (no style attribute / <style>), greys only.
 */
import { paperDefs, paperIds, paperOverlay } from './paper.ts';
import { DEFAULT_PENCIL_LOOK, paperLevel, type PencilLook } from './pencil-look.ts';
import { attrs, el, gray, num } from './svg.ts';

export const RASTER_POST_VERSION = 'raster-post-v1';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SVG_OPEN = /^\s*<svg\b[^>]*>/;

function viewBoxOf(svgOpen: string): string | null {
  const m = /\bviewBox="([^"]+)"/.exec(svgOpen);
  return m ? (m[1] as string) : null;
}

/**
 * Place a complete board SVG (its own viewBox) at `box` inside a canvas of
 * `canvas` px on plain `paper`. The board content is transformed, not nested
 * in an <svg>/clipPath (resvg drops a clip-path nested inside another clip,
 * which blanked the structure render); anything drawn past the frame is
 * covered by paper margin rects instead.
 */
export function padControlSvg(boardSvg: string, canvas: { w: number; h: number }, box: Box, paper: string = gray(255)): string {
  const m = SVG_OPEN.exec(boardSvg);
  if (!m) throw new Error('padControlSvg: not an <svg> document');
  const end = boardSvg.lastIndexOf('</svg>');
  if (end < m[0].length) throw new Error('padControlSvg: unterminated <svg> document');
  const vb = (viewBoxOf(m[0]) ?? '').trim().split(/[\s,]+/).map(Number);
  const [vx, vy, vw, vh] = vb.length === 4 && vb.every(Number.isFinite) && (vb[2] as number) > 0 && (vb[3] as number) > 0 ? (vb as [number, number, number, number]) : [0, 0, box.w, box.h];
  const sx = box.w / vw;
  const sy = box.h / vh;
  const k = (v: number) => String(Math.round(v * 1e6) / 1e6);
  const transform = `translate(${k(box.x - vx * sx)} ${k(box.y - vy * sy)}) scale(${k(sx)} ${k(sy)})`;
  const inner = boardSvg.slice(m[0].length, end);
  const margins: string[] = [];
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  if (box.y > 0) margins.push(el('rect', { x: 0, y: 0, width: canvas.w, height: box.y, fill: paper }));
  if (y1 < canvas.h) margins.push(el('rect', { x: 0, y: y1, width: canvas.w, height: canvas.h - y1, fill: paper }));
  if (box.x > 0) margins.push(el('rect', { x: 0, y: 0, width: box.x, height: canvas.h, fill: paper }));
  if (x1 < canvas.w) margins.push(el('rect', { x: x1, y: 0, width: canvas.w - x1, height: canvas.h, fill: paper }));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${attrs({ viewBox: `0 0 ${num(canvas.w)} ${num(canvas.h)}`, width: canvas.w, height: canvas.h })}>` +
    el('rect', { x: 0, y: 0, width: canvas.w, height: canvas.h, fill: paper }) +
    `<g transform="${transform}">${inner}</g>` +
    margins.join('') +
    '</svg>'
  );
}

export interface RasterPostInput {
  /** data URL of the returned image (image/png, image/jpeg or image/gif) */
  href: string;
  /** pixel size of the returned image */
  width: number;
  height: number;
  /** frame box as fractions of the returned image (CanvasPlan.crop) */
  crop: { x0: number; y0: number; x1: number; y1: number };
  /** output frame size (viewBox units, e.g. frameSize(aspect)) */
  out: { W: number; H: number };
  look?: PencilLook;
}

/** Graphite range on paper: darkest level and a gentle mid-tone curve. */
export const RASTER_LEVELS = [0.12, 0.3, 0.55, 0.78] as const;

export function rasterPostSvg(input: RasterPostInput): string {
  const look = input.look ?? DEFAULT_PENCIL_LOOK;
  if (!/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(input.href)) {
    throw new Error('rasterPostSvg: href must be a base64 PNG/JPEG/GIF data URL');
  }
  const { W, H } = input.out;
  const paperL = paperLevel(look.paperTone);
  const paper = gray(paperL);
  const top = paperL / 255;
  const table = [...RASTER_LEVELS, Math.round(top * 1000) / 1000].join(' ');
  const cx = input.crop.x0 * input.width;
  const cy = input.crop.y0 * input.height;
  const cw = Math.max(1e-6, (input.crop.x1 - input.crop.x0) * input.width);
  const ch = Math.max(1e-6, (input.crop.y1 - input.crop.y0) * input.height);
  const ids = paperIds('rp');
  const func = (c: 'R' | 'G' | 'B') => el(`feFunc${c}`, { type: 'table', tableValues: table });
  const filter =
    `<filter${attrs({ id: 'rp-f', x: 0, y: 0, width: 1, height: 1, 'color-interpolation-filters': 'sRGB' })}>` +
    el('feColorMatrix', { type: 'saturate', values: 0 }) +
    `<feComponentTransfer>${func('R')}${func('G')}${func('B')}</feComponentTransfer>` +
    '</filter>';
  // crop = scale the recorded frame box onto the output; the rest falls outside the canvas
  const k = (v: number) => String(Math.round(v * 1e6) / 1e6);
  const transform = `scale(${k(W / cw)} ${k(H / ch)}) translate(${k(-cx)} ${k(-cy)})`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${attrs({ viewBox: `0 0 ${num(W)} ${num(H)}`, width: W, height: H })}>` +
    `<defs>${filter}${paperDefs(ids, look.grain, look.vignette)}</defs>` +
    el('rect', { x: 0, y: 0, width: W, height: H, fill: paper }) +
    `<g transform="${transform}">` +
    el('image', { href: input.href, x: 0, y: 0, width: input.width, height: input.height, preserveAspectRatio: 'none', filter: 'url(#rp-f)' }) +
    '</g>' +
    paperOverlay(ids, W, H, look.grain, look.vignette) +
    '</svg>'
  );
}
