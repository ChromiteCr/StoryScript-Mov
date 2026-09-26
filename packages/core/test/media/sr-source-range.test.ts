import type { StreamInfo } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import { checkSourceRangeShape, validateSourceRange, wholeStreamRange } from '../../src/media/source-range.ts';

const stream = (over: Partial<StreamInfo> = {}): StreamInfo => ({
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  profile: 'High',
  pix_fmt: 'yuv420p',
  width: 1920,
  height: 1080,
  time_base_num: 1,
  time_base_den: 90000,
  start_pts: 0,
  duration_ts: 900000,
  r_frame_rate: '25/1',
  avg_frame_rate: '25/1',
  bits_per_raw_sample: 8,
  ...over,
});
const asset = { probe: { streams: [stream(), stream({ index: 1, codec_type: 'audio', time_base_den: 48000, start_pts: null, duration_ts: null })] } };
const good = { stream_index: 0, in_pts: 90000, out_pts: 450000, time_base_num: 1, time_base_den: 90000 };

describe('SR: validateSourceRange against the probed asset', () => {
  test('accepts a range inside the stream with the stream time base', () => {
    expect(validateSourceRange(good, asset)).toEqual({ ok: true });
    expect(validateSourceRange({ ...good, in_pts: 0, out_pts: 900000 }, asset)).toEqual({ ok: true });
    // no start/duration reported → no bounds check
    expect(validateSourceRange({ stream_index: 1, in_pts: -10, out_pts: 10, time_base_num: 1, time_base_den: 48000 }, asset)).toEqual({ ok: true });
  });

  test.each([
    ['float PTS', { ...good, in_pts: 1.5 }, 'NOT_INTEGER', 'VALIDATION_ERROR'],
    ['string PTS', { ...good, out_pts: '450000' }, 'NOT_INTEGER', 'VALIDATION_ERROR'],
    ['missing field', { stream_index: 0, in_pts: 0, out_pts: 1, time_base_num: 1 }, 'NOT_INTEGER', 'VALIDATION_ERROR'],
    ['unsafe PTS', { ...good, out_pts: Number.MAX_SAFE_INTEGER + 2 }, 'UNSAFE_INTEGER', 'UNSUPPORTED_TIMEBASE'],
    ['zero denominator', { ...good, time_base_den: 0 }, 'INVALID_TIMEBASE', 'VALIDATION_ERROR'],
    ['in = out', { ...good, out_pts: 90000 }, 'EMPTY_RANGE', 'VALIDATION_ERROR'],
    ['in > out', { ...good, in_pts: 500000 }, 'EMPTY_RANGE', 'VALIDATION_ERROR'],
    ['stream missing', { ...good, stream_index: 7 }, 'STREAM_NOT_FOUND', 'VALIDATION_ERROR'],
    ['time base differs', { ...good, time_base_den: 25 }, 'UNSUPPORTED_TIMEBASE', 'UNSUPPORTED_TIMEBASE'],
    ['equivalent but not identical time base', { ...good, time_base_num: 2, time_base_den: 180000 }, 'UNSUPPORTED_TIMEBASE', 'UNSUPPORTED_TIMEBASE'],
    ['past the end', { ...good, out_pts: 900001 }, 'OUT_OF_BOUNDS', 'VALIDATION_ERROR'],
    ['before the start', { ...good, in_pts: -1 }, 'OUT_OF_BOUNDS', 'VALIDATION_ERROR'],
  ])('rejects %s', (_name, range, problem, code) => {
    const r = validateSourceRange(range, asset);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toBe(problem);
      expect(r.code).toBe(code);
    }
  });

  test('without probe data the range cannot be verified', () => {
    expect(validateSourceRange(good, { probe: null })).toMatchObject({ ok: false, problem: 'NO_PROBE' });
    expect(validateSourceRange(good, null)).toMatchObject({ ok: false, problem: 'NO_PROBE' });
    expect(checkSourceRangeShape(good)).toEqual({ ok: true });
  });

  test('whole-stream link is exactly [start_pts, start_pts + duration_ts)', () => {
    expect(wholeStreamRange(stream({ start_pts: 1001, duration_ts: 90090 }))).toEqual({
      stream_index: 0,
      in_pts: 1001,
      out_pts: 91091,
      time_base_num: 1,
      time_base_den: 90000,
    });
    expect(wholeStreamRange(stream({ duration_ts: null }))).toBeNull();
    expect(wholeStreamRange(stream({ start_pts: Number.MAX_SAFE_INTEGER, duration_ts: 10 }))).toBeNull();
    const whole = wholeStreamRange(stream())!;
    expect(validateSourceRange(whole, asset)).toEqual({ ok: true });
  });
});
