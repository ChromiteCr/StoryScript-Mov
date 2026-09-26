import { describe, expect, test } from 'vitest';
import { contentTypeFor, parseRange, rangeHeaders } from '../src/http/range.ts';

describe('parseRange (single bytes range)', () => {
  const size = 1000;

  test.each([
    ['bytes=0-499', { start: 0, end: 499 }],
    ['bytes=0-0', { start: 0, end: 0 }],
    ['bytes=500-999', { start: 500, end: 999 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=0-', { start: 0, end: 999 }],
    ['bytes=999-', { start: 999, end: 999 }],
    ['bytes=900-5000', { start: 900, end: 999 }], // end clamped
    ['bytes=-1', { start: 999, end: 999 }],
    ['bytes=-500', { start: 500, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }], // suffix longer than file → whole file
    ['BYTES = 10-20', { start: 10, end: 20 }], // unit is case-insensitive, OWS tolerated
    ['bytes=0-99999999999999999999', { start: 0, end: 999 }],
  ])('%s', (h, want) => {
    expect(parseRange(h, size)).toEqual(want);
  });

  test.each([
    ['bytes=1000-', 'start == size'],
    ['bytes=1000-1000', 'start == size'],
    ['bytes=5000-6000', 'start beyond size'],
    ['bytes=-0', 'zero-length suffix'],
  ])('%s → unsatisfiable (%s)', (h) => {
    expect(parseRange(h, size)).toBe('unsatisfiable');
  });

  test.each([
    [undefined],
    [''],
    ['items=0-10'],
    ['bytes'],
    ['bytes='],
    ['bytes=-'],
    ['bytes=abc-'],
    ['bytes=5-2'], // last < first is invalid syntax → ignored
    ['bytes=0-1,5-6'], // multi-range not supported → ignored
    ['bytes=1.5-3'],
    ['bytes=-1-2'],
    ['bytes=0x10-'],
  ])('%s → null (ignored, serve 200)', (h) => {
    expect(parseRange(h, size)).toBeNull();
  });

  test('empty file: every range is unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-10', 0)).toBe('unsatisfiable');
    expect(parseRange(undefined, 0)).toBeNull();
  });

  test('large file offsets stay exact (> 4 GiB)', () => {
    const big = 8 * 1024 ** 3 + 17;
    expect(parseRange('bytes=6442450944-', big)).toEqual({ start: 6442450944, end: big - 1 });
    expect(parseRange('bytes=-17', big)).toEqual({ start: big - 17, end: big - 1 });
  });
});

describe('rangeHeaders', () => {
  test('206 carries Content-Range, Content-Length, Accept-Ranges', () => {
    expect(rangeHeaders({ start: 0, end: 499 }, 1000)).toEqual({
      status: 206,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 0-499/1000', 'Content-Length': '500' },
    });
    expect(rangeHeaders({ start: 999, end: 999 }, 1000).headers['Content-Length']).toBe('1');
  });

  test('416 advertises the full size', () => {
    expect(rangeHeaders('unsatisfiable', 1000)).toEqual({
      status: 416,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes */1000' },
    });
  });

  test('no range → 200 with full length', () => {
    expect(rangeHeaders(null, 1000)).toEqual({
      status: 200,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '1000' },
    });
  });
});

describe('contentTypeFor', () => {
  test.each([
    ['.mp4', 'video/mp4'],
    ['mp4', 'video/mp4'],
    ['.MOV', 'video/mp4'], // served as mp4 so Chromium tries to play it
    ['.m4v', 'video/mp4'],
    ['.jpg', 'image/jpeg'],
    ['.JPEG', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.mxf', 'application/octet-stream'],
    ['', 'application/octet-stream'],
  ])('%s → %s', (ext, type) => {
    expect(contentTypeFor(ext)).toBe(type);
  });
});
