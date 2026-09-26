/**
 * Minimal SVG string helpers. Presentation attributes only (no `style`
 * attribute, no <style> element); every text node and attribute value is
 * escaped; numbers are fixed to two decimals.
 */
import type { V2 } from './math.ts';

/** Two-decimal number formatting without trailing zeros; never "-0". */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 100) / 100;
  if (r === 0) return '0';
  return String(r);
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type Attrs = Record<string, string | number | null | undefined | false>;

export function attrs(a: Attrs): string {
  let out = '';
  for (const k of Object.keys(a)) {
    const v = a[k];
    if (v === null || v === undefined || v === false) continue;
    out += ` ${k}="${typeof v === 'number' ? num(v) : escapeXml(v)}"`;
  }
  return out;
}

export function el(tag: string, a: Attrs, children?: string): string {
  return children === undefined ? `<${tag}${attrs(a)}/>` : `<${tag}${attrs(a)}>${children}</${tag}>`;
}

export function text(a: Attrs, content: string): string {
  return `<text${attrs(a)}>${escapeXml(content)}</text>`;
}

/** Closed path "M…L…Z" from points already in SVG units. */
export function polyPath(pts: readonly V2[], close = true): string {
  if (pts.length === 0) return '';
  let d = `M${num(pts[0]![0])} ${num(pts[0]![1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${num(pts[i]![0])} ${num(pts[i]![1])}`;
  return close ? `${d}Z` : d;
}

/** Validated grey: returns #rrggbb with r = g = b. */
export function gray(level: number): string {
  const v = Math.max(0, Math.min(255, Math.round(level)));
  const h = v.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

export const INK = '#000000';
export const PAPER = '#ffffff';
