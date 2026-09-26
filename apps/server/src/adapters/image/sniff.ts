/**
 * Image type and pixel size from magic bytes (PNG, JPEG, GIF, WebP). No
 * decoding; unknown → null. resvg can post-process PNG, JPEG and GIF only.
 */

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  width: number | null;
  height: number | null;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const len = u16be(b, i + 2);
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return { mime: 'image/png', ext: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const s = jpegSize(b);
    return { mime: 'image/jpeg', ext: 'jpg', width: s?.width ?? null, height: s?.height ?? null };
  }
  if (b.length >= 10 && ascii(b, 0, 4) === 'GIF8') {
    return { mime: 'image/gif', ext: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const s = webpSize(b);
    return { mime: 'image/webp', ext: 'webp', width: s?.width ?? null, height: s?.height ?? null };
  }
  return null;
}
