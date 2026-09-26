/**
 * Single-range HTTP byte serving (RFC 9110 §14) for direct media playback.
 * Only one `bytes=` range is honoured; anything we do not understand
 * (other units, multiple ranges, malformed specs) is ignored → full 200,
 * which RFC 9110 permits. Out-of-bounds but well-formed ranges → 416.
 */

export interface ByteRange {
  /** inclusive */
  start: number;
  /** inclusive */
  end: number;
}

export type RangeResult = ByteRange | 'unsatisfiable' | null;

const DIGITS = /^\d+$/;

export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return null;
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!m) return null;
  const spec = (m[1] ?? '').trim();
  if (spec === '' || spec.includes(',')) return null;

  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const first = spec.slice(0, dash).trim();
  const last = spec.slice(dash + 1).trim();

  if (first === '') {
    // suffix range: last n bytes
    if (!DIGITS.test(last)) return null;
    const n = Number(last);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  if (!DIGITS.test(first)) return null;
  const start = Number(first);
  let end: number;
  if (last === '') {
    end = size - 1;
  } else {
    if (!DIGITS.test(last)) return null;
    end = Number(last);
    if (end < start) return null; // syntactically invalid → ignore
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

export interface RangeResponseHead {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
}

/** Status + headers for a parsed range (Content-Type is added by the caller). */
export function rangeHeaders(range: RangeResult, size: number): RangeResponseHead {
  if (range === 'unsatisfiable') {
    return { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` } };
  }
  if (range === null) {
    return { status: 200, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(size) } };
  }
  return {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(range.end - range.start + 1),
    },
  };
}

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  // QuickTime served as MP4 so Chromium attempts playback (ISO BMFF compatible)
  mov: 'video/mp4',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function contentTypeFor(ext: string): string {
  return TYPES[ext.trim().replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}
