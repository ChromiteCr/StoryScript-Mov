import type { BoardSpec, ImageDialect, ImagePreset } from '@storyscript/contracts';
import {
  DEFAULT_PENCIL_LOOK,
  frameSize,
  padControlSvg,
  paperLevel,
  planCanvas,
  rasterPostSvg,
  renderBoard,
  type CanvasPlan,
  type PixelWindow,
} from '@storyscript/core';
import { sha256Hex } from '../../adapters/image/payload.ts';
import type { ReturnedImage } from '../../adapters/image/types.ts';
import { svgToPng } from '../../adapters/render/resvg.ts';

/**
 * Control image and post-processing (SPEC FR-12), both rendered by resvg:
 *
 *  - control: renderBoard(spec, mode, {overlay:false}) — no text, no badges,
 *    no arrows — contain-fit on a canvas of the ratio the service returns,
 *    plain paper margins (core padControlSvg);
 *  - post: desaturate, compress levels, crop back to the frame box recorded
 *    in the CanvasPlan, paper grain + vignette (core rasterPostSvg) → PNG at
 *    the board frame size, so the vector annotation layer stays aligned.
 */

export type ControlMode = 'pencil' | 'structure';

export function canvasFor(dialect: ImageDialect, preset: ImagePreset | null, aspect: BoardSpec['frame']['aspect'], window: PixelWindow): CanvasPlan {
  if (dialect === 'openai-edits' || !preset) return planCanvas(aspect, { mode: 'exact' });
  if (preset.size_mode === 'aspect_enum') return planCanvas(aspect, { mode: 'aspect_enum', aspect_values: preset.aspect_values });
  return planCanvas(aspect, { mode: 'pixels', window });
}

const hexGray = (level: number) => {
  const h = Math.max(0, Math.min(255, Math.round(level))).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

export interface ControlImage {
  png: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  mode: ControlMode;
}

export async function renderControl(spec: BoardSpec, mode: ControlMode, plan: CanvasPlan): Promise<ControlImage> {
  const board = renderBoard(spec, mode, { overlay: false });
  const paper = mode === 'pencil' ? hexGray(paperLevel(DEFAULT_PENCIL_LOOK.paperTone)) : '#ffffff';
  const svg = padControlSvg(board, plan.canvas, plan.frame_box, paper);
  const png = await svgToPng(svg, { width: plan.canvas.w });
  return { png, sha256: sha256Hex(png), width: plan.canvas.w, height: plan.canvas.h, mode };
}

export const POSTABLE = new Set(['image/png', 'image/jpeg', 'image/gif']);

export class PostProcessError extends Error {}

/** Returned image → final PNG at the frame size (1840 px wide). */
export async function postProcess(image: ReturnedImage, plan: CanvasPlan, aspect: BoardSpec['frame']['aspect']): Promise<{ png: Uint8Array; width: number; height: number }> {
  if (!POSTABLE.has(image.mime)) throw new PostProcessError(`返回图为 ${image.mime}，当前版本只能后处理 PNG/JPEG/GIF`);
  if (!image.width || !image.height) throw new PostProcessError('无法读取返回图的尺寸');
  const { W, H } = frameSize(aspect);
  const href = `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`;
  const svg = rasterPostSvg({ href, width: image.width, height: image.height, crop: plan.crop, out: { W, H } });
  const png = await svgToPng(svg, { width: W });
  return { png, width: W, height: Math.round(H) };
}
