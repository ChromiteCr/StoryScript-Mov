import { DEFAULT_PIXEL_WINDOW, type ImagePromptLang, type PixelWindow } from '@storyscript/core';
import { z } from 'zod';
import type { DbPort } from '../../db/port.ts';
import { kvRead } from '../../db/repos/raster.ts';

/**
 * Project-level redraw options kept in the kv table (no new columns). All
 * optional; invalid values fall back to the defaults.
 *
 *   image.raster_cap     soft cap on AI candidates per project (default 50)
 *   image.control_mode   'pencil' (default) | 'structure' — control image look;
 *                        pencil is an untested initial assumption (D1 A/B not
 *                        run), see docs/providers.md
 *   image.pixel_window   PixelWindow for pixel-size services (default: 2K tier)
 *   image.prompt_lang    'en' (default) | 'zh'
 */

export const KV_RASTER_CAP = 'image.raster_cap';
export const KV_CONTROL_MODE = 'image.control_mode';
export const KV_PIXEL_WINDOW = 'image.pixel_window';
export const KV_PROMPT_LANG = 'image.prompt_lang';

export const DEFAULT_RASTER_CAP = 50;

const Window = z.object({
  tier: z.string(),
  target_pixels: z.number().int().positive(),
  min_pixels: z.number().int().positive(),
  max_pixels: z.number().int().positive(),
  multiple: z.number().int().positive(),
});

export interface RedrawOptions {
  raster_cap: number;
  control_mode: 'pencil' | 'structure';
  pixel_window: PixelWindow;
  prompt_lang: ImagePromptLang;
}

export function redrawOptions(db: DbPort): RedrawOptions {
  const cap = z.number().int().nonnegative().safeParse(kvRead(db, KV_RASTER_CAP));
  const mode = z.enum(['pencil', 'structure']).safeParse(kvRead(db, KV_CONTROL_MODE));
  const win = Window.safeParse(kvRead(db, KV_PIXEL_WINDOW));
  const lang = z.enum(['en', 'zh']).safeParse(kvRead(db, KV_PROMPT_LANG));
  return {
    raster_cap: cap.success ? cap.data : DEFAULT_RASTER_CAP,
    control_mode: mode.success ? mode.data : 'pencil',
    pixel_window: win.success && win.data.min_pixels <= win.data.max_pixels ? win.data : DEFAULT_PIXEL_WINDOW,
    prompt_lang: lang.success ? lang.data : 'en',
  };
}
