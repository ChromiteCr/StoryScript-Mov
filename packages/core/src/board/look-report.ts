/**
 * One look report per board: which renders feed which metric. The rasteriser
 * is injected (resvg on the server / in `npm run look`), so this stays pure.
 *
 * Renders used (all overlay-free):
 *  - pencil @ `width` (default 1840)                → L1, L2, L4, L5, L6
 *  - pencil @ 240 + silhouette mask @ 240           → L3
 *  - people masks per depth band / nearest person   → L4, L6 (occlusion-aware)
 *  - tone map (tone ≥ 1)                            → L5 region
 *  - contour layer @ `width`                        → L7
 */
import type { BoardSpec } from '@storyscript/contracts';
import {
  l1ToneClusters,
  l2MaxSaturation,
  l3SilhouetteIoU,
  l4DepthOrder,
  l5HatchDirection,
  l6ForegroundPaper,
  l7LineWidthCV,
  LOOK_THRESHOLDS,
  luminance,
  maskArea,
  maskFrom,
  type DepthOrder,
  type HatchDirection,
  type LineWidths,
  type Mask,
  type RgbaImage,
  type SilhouetteIoU,
  type ToneClusters,
} from './look-metrics.ts';
import { DEFAULT_PENCIL_LOOK, type PencilLook } from './pencil-look.ts';
import { renderSubjectMask, renderToneMap } from './pencil-masks.ts';
import { subjectBands, type DepthBand } from './pencil-plan.ts';
import { renderPencil } from './pencil.ts';

export type Rasterize = (svg: string, width: number) => Promise<RgbaImage> | RgbaImage;

export interface LookReport {
  l1: ToneClusters;
  l2: number;
  /** null: no people in frame */
  l3: SilhouetteIoU | null;
  /** thumbnail silhouette area (px @ 240) — tiny figures make L3 meaningless */
  l3Area: number;
  l4: DepthOrder;
  /** depth bands present among visible people */
  bands: DepthBand[];
  l5: HatchDirection;
  /** null: no people in frame */
  l6: number | null;
  l6Subject: string | null;
  /** visible area (px @ width) of the L6 subject */
  l6Area: number;
  l7: LineWidths;
}

export async function measureLook(spec: BoardSpec, raster: Rasterize, o: { look?: PencilLook; width?: number } = {}): Promise<LookReport> {
  const look = o.look ?? DEFAULT_PENCIL_LOOK;
  const W = o.width ?? 1840;
  const tw = LOOK_THRESHOLDS.l3.thumbWidth;
  const pencil = renderPencil(spec, { overlay: false, look });
  const full = await raster(pencil, W);
  const lum = luminance(full);
  const l1 = l1ToneClusters(lum);
  const l2 = l2MaxSaturation(full);

  const thumb = await raster(pencil, tw);
  const sil = maskFrom(await raster(renderSubjectMask(spec, { width: tw }), tw));
  const l3Area = maskArea(sil);
  const l3 = l3Area > 0 ? l3SilhouetteIoU(thumb, sil) : null;

  const infos = subjectBands(spec);
  const bandMasks: Partial<Record<DepthBand, Mask>> = {};
  const bands: DepthBand[] = [];
  for (const band of ['fg', 'mg', 'bg'] as const) {
    if (!infos.some((s) => s.band === band)) continue;
    const m = maskFrom(await raster(renderSubjectMask(spec, { bands: [band], width: W }), W));
    if (maskArea(m) > 0) {
      bandMasks[band] = m;
      bands.push(band);
    }
  }
  const l4 = l4DepthOrder(lum, bandMasks);

  const toned = maskFrom(await raster(renderToneMap(spec, { width: W }), W), 0.3);
  const l5 = l5HatchDirection(lum, full.width, full.height, toned, look.angle);

  // the foreground subject: the nearest person that is visible in frame
  let l6: number | null = null;
  let l6Subject: string | null = null;
  let l6Area = 0;
  for (const s of infos.slice().sort((a, b) => a.depth - b.depth)) {
    const m = maskFrom(await raster(renderSubjectMask(spec, { ids: [s.id], width: W }), W));
    const area = maskArea(m);
    if (area < 200) continue;
    l6 = l6ForegroundPaper(lum, m);
    l6Subject = s.id;
    l6Area = area;
    break;
  }

  const contour = await raster(renderPencil(spec, { overlay: false, look, layers: 'contour' }), W);
  const l7 = l7LineWidthCV(luminance(contour), contour.width, contour.height);
  return { l1, l2, l3, l3Area, l4, bands, l5, l6, l6Subject, l6Area, l7 };
}
