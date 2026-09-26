import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

/**
 * Server-side SVG → PNG/RGBA via resvg-wasm (MPL-2.0, used unmodified as an
 * external dependency). No fonts are loaded, so <text> is simply not drawn:
 * server PNGs (control images, look metrics) are text-free by design.
 * Every Resvg / RenderedImage handle is freed after use (wasm heap).
 */

let ready: Promise<void> | null = null;

export function initResvg(): Promise<void> {
  if (!ready) {
    const wasmPath = createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
    ready = initWasm(readFileSync(wasmPath)).catch((e: unknown) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export interface RenderOptions {
  /** output width in px; height follows the SVG aspect ratio */
  width: number;
  /** CSS color; default transparent */
  background?: string;
}

export interface Pixels {
  width: number;
  height: number;
  /** straight (non-premultiplied) RGBA, row-major */
  rgba: Uint8Array;
}

function render<T>(svg: string, opts: RenderOptions, read: (img: ReturnType<InstanceType<typeof Resvg>['render']>) => T): T {
  if (!Number.isInteger(opts.width) || opts.width < 1 || opts.width > 16384) {
    throw new RangeError(`bad width: ${opts.width}`);
  }
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: opts.width },
    background: opts.background,
    font: { loadSystemFonts: false },
  });
  try {
    const img = r.render();
    try {
      return read(img);
    } finally {
      img.free();
    }
  } finally {
    r.free();
  }
}

export async function svgToPng(svg: string, opts: RenderOptions): Promise<Uint8Array> {
  await initResvg();
  return render(svg, opts, (img) => img.asPng());
}

/** tiny-skia keeps premultiplied alpha; un-premultiply so metrics see real colors. */
function unpremultiply(px: Uint8Array): void {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a === 0 || a === 255) continue;
    px[i] = Math.min(255, Math.round((px[i]! * 255) / a));
    px[i + 1] = Math.min(255, Math.round((px[i + 1]! * 255) / a));
    px[i + 2] = Math.min(255, Math.round((px[i + 2]! * 255) / a));
  }
}

export async function svgToPixels(svg: string, opts: RenderOptions): Promise<Pixels> {
  await initResvg();
  return render(svg, opts, (img) => {
    const rgba = new Uint8Array(img.pixels); // copy out of wasm memory before free()
    unpremultiply(rgba);
    return { width: img.width, height: img.height, rgba };
  });
}
