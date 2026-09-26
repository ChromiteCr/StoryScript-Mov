import { ProbeNormalized, SourceRange } from '@storyscript/contracts';
import { describe, expect, test } from 'vitest';
import {
  deriveMediaFlags,
  isVfrSuspect,
  normalizeProbe,
  parseFfRational,
  wholeAssetSourceRange,
} from '../src/index.ts';

/** Hand-written ffprobe fragments (shape of `-show_format -show_streams -print_format json`). */
const MOV = 'mov,mp4,m4a,3gp,3g2,mj2';

const h264Stream = {
  index: 0,
  codec_name: 'h264',
  profile: 'High',
  codec_type: 'video',
  codec_tag_string: 'avc1',
  width: 640,
  height: 360,
  pix_fmt: 'yuv420p',
  r_frame_rate: '25/1',
  avg_frame_rate: '25/1',
  time_base: '1/12800',
  start_pts: 0,
  duration_ts: 25600,
  bits_per_raw_sample: '8',
  disposition: { default: 1, attached_pic: 0 },
  tags: { handler_name: 'VideoHandler' },
};
const aacStream = {
  index: 1,
  codec_name: 'aac',
  profile: 'LC',
  codec_type: 'audio',
  r_frame_rate: '0/0',
  avg_frame_rate: '0/0',
  time_base: '1/48000',
  start_pts: -1024,
  duration_ts: 96000,
};
const h264Probe = {
  streams: [h264Stream, aacStream],
  format: { format_name: MOV, duration: '2.000000', tags: { major_brand: 'isom' } },
};

describe('parseFfRational', () => {
  test.each([
    ['1/12800', { num: 1, den: 12800 }],
    ['1001/30000', { num: 1001, den: 30000 }],
    [' 25/1 ', { num: 25, den: 1 }],
  ])('%s', (s, want) => expect(parseFfRational(s)).toEqual(want));

  test.each(['0/0', '1/0', '0/1', 'N/A', '', '1.5/2', '-1/25', 'abc', null, 12800])('rejects %s', (s) => {
    expect(parseFfRational(s)).toBeNull();
  });
});

describe('normalizeProbe', () => {
  test('H.264 + AAC: integer time bases, rates, bits, schema-valid', () => {
    const p = normalizeProbe(h264Probe);
    expect(ProbeNormalized.parse(p)).toEqual(p);
    expect(p.format_name).toBe(MOV);
    expect(p.duration_s).toBe(2);
    expect(p.streams[0]).toEqual({
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      width: 640,
      height: 360,
      time_base_num: 1,
      time_base_den: 12800,
      start_pts: 0,
      duration_ts: 25600,
      r_frame_rate: '25/1',
      avg_frame_rate: '25/1',
      bits_per_raw_sample: 8,
    });
    // "0/0" rates mean unknown → null; negative start_pts preserved
    expect(p.streams[1]).toMatchObject({ r_frame_rate: null, avg_frame_rate: null, start_pts: -1024, pix_fmt: null });
    expect(p.timecode).toBeNull();
    expect(p.creation_time).toBeNull();
  });

  test('missing start_pts / duration_ts ("N/A" omitted by ffprobe) become null', () => {
    const p = normalizeProbe({
      streams: [{ ...h264Stream, start_pts: undefined, duration_ts: undefined }],
      format: { format_name: 'matroska,webm', duration: '3.5' },
    });
    expect(p.streams[0]).toMatchObject({ start_pts: null, duration_ts: null });
  });

  test('integer-valued strings are accepted, floats and unsafe values are not', () => {
    const p = normalizeProbe({
      streams: [
        { ...h264Stream, start_pts: '-2002', duration_ts: '48048' },
        { ...aacStream, start_pts: 1.5, duration_ts: 2 ** 60 },
      ],
      format: { format_name: MOV },
    });
    expect(p.streams[0]).toMatchObject({ start_pts: -2002, duration_ts: 48048 });
    expect(p.streams[1]).toMatchObject({ start_pts: null, duration_ts: null });
    expect(p.duration_s).toBeNull();
  });

  test('timecode from format tags wins; creation_time kept verbatim', () => {
    const p = normalizeProbe({
      ...h264Probe,
      format: { ...h264Probe.format, tags: { timecode: '01:00:00:00', creation_time: '2026-01-02T03:04:05.000000Z' } },
    });
    expect(p.timecode).toBe('01:00:00:00');
    expect(p.creation_time).toBe('2026-01-02T03:04:05.000000Z');
  });

  test('timecode from a tmcd data stream (MOV camera files)', () => {
    const p = normalizeProbe({
      streams: [
        h264Stream,
        aacStream,
        {
          index: 2,
          codec_type: 'data',
          codec_tag_string: 'tmcd',
          time_base: '1/12800',
          avg_frame_rate: '12800/512',
          r_frame_rate: '0/0',
          tags: { timecode: '10:59:58:12' },
        },
      ],
      format: { format_name: MOV, duration: '2.0' },
    });
    expect(p.timecode).toBe('10:59:58:12');
    expect(p.streams.map((s) => s.codec_type)).toEqual(['video', 'audio', 'data']);
  });

  test('timecode from video stream tags, case-insensitive key', () => {
    const p = normalizeProbe({
      streams: [{ ...h264Stream, tags: { TIMECODE: '00:00:10;02' } }],
      format: { format_name: 'mxf' },
    });
    expect(p.timecode).toBe('00:00:10;02');
  });

  test('cover art (attached_pic) is dropped; unknown codec_type maps to "unknown"', () => {
    const p = normalizeProbe({
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'mp3', time_base: '1/14112000', r_frame_rate: '0/0' },
        { index: 1, codec_type: 'video', codec_name: 'mjpeg', time_base: '1/90000', disposition: { attached_pic: 1 } },
        { index: 2, codec_type: 'weird', time_base: '1/1000' },
      ],
      format: { format_name: 'mp3', duration: '180.1' },
    });
    expect(p.streams.map((s) => [s.index, s.codec_type])).toEqual([
      [0, 'audio'],
      [2, 'unknown'],
    ]);
  });

  test('garbage input never throws and stays schema-valid', () => {
    for (const junk of [null, undefined, 42, 'x', [], { streams: 'no' }, { streams: [null, 1, { index: 'a' }] }]) {
      const p = normalizeProbe(junk);
      expect(ProbeNormalized.safeParse(p).success).toBe(true);
      expect(p.streams).toEqual([]);
    }
  });

  test('streams without a positive integer time_base are skipped', () => {
    const p = normalizeProbe({ streams: [{ ...h264Stream, time_base: '0/0' }, aacStream], format: {} });
    expect(p.streams.map((s) => s.index)).toEqual([1]);
    expect(p.format_name).toBe('unknown');
  });
});

describe('deriveMediaFlags', () => {
  const flags = (raw: unknown, ext: string) => deriveMediaFlags(normalizeProbe(raw), ext);

  test('H.264 8-bit 4:2:0 in mp4/mov/m4v is playable_direct', () => {
    for (const ext of ['mp4', '.MOV', 'm4v']) {
      expect(flags(h264Probe, ext)).toEqual({
        video_stream_index: 0,
        playable_direct: true,
        is_vfr_suspect: false,
        has_timecode: false,
        kind: 'video',
      });
    }
    // full-range yuvj420p also plays
    expect(flags({ ...h264Probe, streams: [{ ...h264Stream, pix_fmt: 'yuvj420p' }] }, 'mov').playable_direct).toBe(true);
  });

  test('same stream in another container / extension is not playable_direct', () => {
    expect(flags(h264Probe, 'mkv').playable_direct).toBe(false);
    expect(flags({ ...h264Probe, format: { format_name: 'mpegts' } }, 'mp4').playable_direct).toBe(false);
  });

  test('H.264 10-bit or 4:2:2 is not playable_direct', () => {
    const hi10 = { ...h264Stream, profile: 'High 10', pix_fmt: 'yuv420p10le', bits_per_raw_sample: '10' };
    const hi422 = { ...h264Stream, profile: 'High 4:2:2', pix_fmt: 'yuv422p10le', bits_per_raw_sample: '10' };
    expect(flags({ ...h264Probe, streams: [hi10] }, 'mp4').playable_direct).toBe(false);
    expect(flags({ ...h264Probe, streams: [hi422] }, 'mov').playable_direct).toBe(false);
    // 8-bit pix_fmt but 10-bit samples reported → still refused
    expect(flags({ ...h264Probe, streams: [{ ...h264Stream, bits_per_raw_sample: '10' }] }, 'mp4').playable_direct).toBe(
      false,
    );
  });

  test('HEVC Main10 (no bits_per_raw_sample, as VideoToolbox writes it)', () => {
    const hevc = {
      index: 0,
      codec_name: 'hevc',
      profile: 'Main 10',
      codec_type: 'video',
      codec_tag_string: 'hvc1',
      pix_fmt: 'yuv420p10le',
      width: 640,
      height: 360,
      r_frame_rate: '25/1',
      avg_frame_rate: '25/1',
      time_base: '1/12800',
      start_pts: 0,
      duration_ts: 25600,
    };
    const f = flags({ streams: [hevc, aacStream], format: { format_name: MOV, duration: '2' } }, 'mov');
    expect(f).toMatchObject({ kind: 'video', video_stream_index: 0, playable_direct: false, is_vfr_suspect: false });
    expect(normalizeProbe({ streams: [hevc], format: {} }).streams[0]?.bits_per_raw_sample).toBeNull();
  });

  test('ProRes 422 is video but not playable_direct', () => {
    const prores = {
      index: 0,
      codec_name: 'prores',
      profile: 'Standard',
      codec_type: 'video',
      pix_fmt: 'yuv422p10le',
      r_frame_rate: '25/1',
      avg_frame_rate: '25/1',
      time_base: '1/12800',
      start_pts: 0,
      duration_ts: 25600,
      bits_per_raw_sample: '10',
    };
    expect(flags({ streams: [prores], format: { format_name: MOV } }, 'mov')).toMatchObject({
      kind: 'video',
      playable_direct: false,
    });
  });

  test('VFR suspicion: rate mismatch > 0.5% or a missing rate', () => {
    const vfr = { ...h264Stream, r_frame_rate: '60/1', avg_frame_rate: '5000/199' };
    expect(flags({ ...h264Probe, streams: [vfr] }, 'mp4')).toMatchObject({ is_vfr_suspect: true, playable_direct: true });
    expect(isVfrSuspect({ r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001' })).toBe(false);
    expect(isVfrSuspect({ r_frame_rate: '30/1', avg_frame_rate: '30000/1001' })).toBe(false); // 0.1%
    expect(isVfrSuspect({ r_frame_rate: '25/1', avg_frame_rate: '2487/100' })).toBe(true); // 0.52%
    expect(isVfrSuspect({ r_frame_rate: '25/1', avg_frame_rate: null })).toBe(true);
  });

  test('has_timecode follows the normalized timecode', () => {
    const tc = { ...h264Probe, format: { ...h264Probe.format, tags: { timecode: '01:00:00:00' } } };
    expect(flags(tc, 'mov').has_timecode).toBe(true);
    expect(flags(h264Probe, 'mov').has_timecode).toBe(false);
  });

  test('audio-only (cover art dropped), image, other', () => {
    const mp3 = {
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'mp3', time_base: '1/14112000' },
        { index: 1, codec_type: 'video', codec_name: 'mjpeg', time_base: '1/90000', disposition: { attached_pic: 1 } },
      ],
      format: { format_name: 'mp3' },
    };
    expect(flags(mp3, 'mp3')).toMatchObject({ kind: 'audio', video_stream_index: null, playable_direct: false });

    const jpg = {
      streams: [{ index: 0, codec_type: 'video', codec_name: 'mjpeg', pix_fmt: 'yuvj420p', time_base: '1/25' }],
      format: { format_name: 'image2' },
    };
    expect(flags(jpg, 'jpg')).toMatchObject({ kind: 'image', video_stream_index: null, playable_direct: false });
    const png = { ...jpg, format: { format_name: 'png_pipe' } };
    expect(flags(png, 'png').kind).toBe('image');

    expect(flags({ streams: [], format: { format_name: 'tty' } }, 'txt').kind).toBe('other');
  });

  test('no probe → kind from extension, all capability flags false', () => {
    expect(deriveMediaFlags(null, '.MOV')).toEqual({
      video_stream_index: null,
      playable_direct: false,
      is_vfr_suspect: false,
      has_timecode: false,
      kind: 'video',
    });
    expect(deriveMediaFlags(null, 'wav').kind).toBe('audio');
    expect(deriveMediaFlags(null, 'jpeg').kind).toBe('image');
    expect(deriveMediaFlags(null, 'txt').kind).toBe('other');
  });
});

describe('wholeAssetSourceRange', () => {
  test('exact [start_pts, start_pts + duration_ts) in the stream time base', () => {
    const r = wholeAssetSourceRange(normalizeProbe(h264Probe), 0);
    expect(r).toEqual({
      range: { stream_index: 0, in_pts: 0, out_pts: 25600, time_base_num: 1, time_base_den: 12800 },
      exact: true,
    });
    expect(SourceRange.safeParse(r?.range).success).toBe(true);
  });

  test('negative start_pts is kept (no zero-origin assumption)', () => {
    const r = wholeAssetSourceRange(normalizeProbe(h264Probe), 1);
    expect(r).toEqual({
      range: { stream_index: 1, in_pts: -1024, out_pts: 94976, time_base_num: 1, time_base_den: 48000 },
      exact: true,
    });
    expect(SourceRange.safeParse(r?.range).success).toBe(true);
  });

  test('missing duration_ts → rounded from format duration, exact=false', () => {
    const p = normalizeProbe({
      streams: [{ ...h264Stream, time_base: '1001/30000', start_pts: 2002, duration_ts: undefined }],
      format: { format_name: MOV, duration: '2.0354' },
    });
    // 2.0354 * 30000 / 1001 = 61.0010 → 61
    expect(wholeAssetSourceRange(p, 0)).toEqual({
      range: { stream_index: 0, in_pts: 2002, out_pts: 2063, time_base_num: 1001, time_base_den: 30000 },
      exact: false,
    });
  });

  test('missing start_pts → 0, exact=false', () => {
    const p = normalizeProbe({ streams: [{ ...h264Stream, start_pts: undefined }], format: { format_name: MOV } });
    expect(wholeAssetSourceRange(p, 0)).toMatchObject({ range: { in_pts: 0, out_pts: 25600 }, exact: false });
  });

  test('unknown stream, zero or missing durations → null', () => {
    const p = normalizeProbe(h264Probe);
    expect(wholeAssetSourceRange(p, 7)).toBeNull();
    const noDur = normalizeProbe({ streams: [{ ...h264Stream, duration_ts: undefined }], format: { format_name: MOV } });
    expect(wholeAssetSourceRange(noDur, 0)).toBeNull();
    const zero = normalizeProbe({ streams: [{ ...h264Stream, duration_ts: 0 }], format: { format_name: MOV, duration: '0' } });
    expect(wholeAssetSourceRange(zero, 0)).toBeNull();
  });

  test('unsafe end PTS → null instead of an invalid range', () => {
    const p = normalizeProbe({
      streams: [{ ...h264Stream, start_pts: Number.MAX_SAFE_INTEGER - 10, duration_ts: 100 }],
      format: { format_name: MOV },
    });
    expect(wholeAssetSourceRange(p, 0)).toBeNull();
  });
});
