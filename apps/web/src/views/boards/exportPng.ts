import type { BoardSpec } from '@storyscript/contracts';
import { frameSize, renderBoard } from '@storyscript/core';
import type { BoardCaption } from '../../lib/print-boards.ts';
import { AI_BADGE_TEXT, aiBadgeBox, renderOverlayOnly } from './raster-layers.ts';

/**
 * Single-frame PNG, composed in the browser: the pencil SVG is loaded from a
 * Blob URL into an <img>, drawn onto a canvas with the caption strip under
 * it, and downloaded via canvas.toBlob. Waits for document.fonts so the
 * caption and the SVG's labels use the final Chinese font. Greyscale only.
 *
 * With an adopted AI raster (FR-12) the frame is the raster (same-origin, so
 * the canvas stays exportable) plus the vector annotation layer, and — unless
 * the export preference turned it off — the "AI 生成" corner mark.
 */

export interface PngAiLayer {
  /** same-origin URL of the adopted raster PNG */
  rasterUrl: string;
  /** draw the "AI 生成" corner mark */
  label: boolean;
}

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
const PAD = 48;
const INK = '#111111';
const MUTED = '#555555';
const PAPER = '#ffffff';

/** Greedy wrap by measured width (works for CJK, which has no spaces). */
export function wrapText(measure: (s: string) => number, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let truncated = false;
  for (const ch of Array.from(text.replace(/\s+/g, ' ').trim())) {
    if (measure(cur + ch) > maxWidth && cur) {
      lines.push(cur);
      cur = ch.trimStart();
      if (lines.length === maxLines) {
        truncated = true;
        break;
      }
    } else cur += ch;
  }
  if (!truncated && cur) lines.push(cur);
  if (truncated) {
    const last = Array.from(lines[maxLines - 1] ?? '');
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 1)).join('')}…`;
  }
  return lines;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('分镜图片加载失败'));
    img.src = url;
  });
}

function drawBadge(ctx: CanvasRenderingContext2D, spec: BoardSpec, code: string, ox: number, oy: number): void {
  const b = aiBadgeBox(spec, code);
  ctx.save();
  ctx.fillStyle = 'rgba(37, 38, 42, 0.92)';
  ctx.beginPath();
  ctx.roundRect(ox + b.x, oy + b.y, b.w, b.h, 4);
  ctx.fill();
  ctx.fillStyle = '#efebe2';
  ctx.font = `700 ${b.font}px ${FONT}`;
  ctx.fillText(AI_BADGE_TEXT, ox + b.tx, oy + b.baseline);
  ctx.restore();
}

export async function composeBoardPng(spec: BoardSpec, caption: BoardCaption, ai: PngAiLayer | null = null): Promise<Blob> {
  if (document.fonts?.ready) await document.fonts.ready;
  const { W, H } = frameSize(spec.frame.aspect);
  const svg = ai ? renderOverlayOnly(spec, caption.code) : renderBoard(spec, 'pencil', { overlay: true, code: caption.code });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const raster = ai ? await loadImage(ai.rasterUrl) : null;
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持画布导出');
    const textW = W;
    ctx.font = `28px ${FONT}`;
    const action = wrapText((s) => ctx.measureText(s).width, `动作：${caption.action}`, textW, 2);
    const dialogue = caption.dialogue ? wrapText((s) => ctx.measureText(s).width, `对白：${caption.dialogue}`, textW, 2) : [];
    const captionH = 36 + 18 + (action.length + dialogue.length) * 40 + 12;
    canvas.width = W + PAD * 2;
    canvas.height = Math.round(H + PAD * 2 + captionH);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (raster) ctx.drawImage(raster, PAD, PAD, W, H);
    ctx.drawImage(img, PAD, PAD, W, H);
    if (ai?.label) drawBadge(ctx, spec, caption.code, PAD, PAD);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, W, H);

    let y = PAD + H + 44;
    ctx.fillStyle = INK;
    ctx.font = `600 34px ${FONT}`;
    ctx.fillText(`镜 ${caption.code}`, PAD, y);
    const head = ctx.measureText(`镜 ${caption.code}`).width;
    ctx.font = `28px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(`${caption.version}　${caption.grammar}　${caption.duration}`, PAD + head + 28, y);
    ctx.fillStyle = INK;
    y += 18;
    for (const line of [...action, ...dialogue]) {
      y += 40;
      ctx.fillText(line, PAD, y);
    }
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
