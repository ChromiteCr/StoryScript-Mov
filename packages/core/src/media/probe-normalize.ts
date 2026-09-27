import type { MediaAsset, ProbeNormalized, SourceRange, StreamInfo } from '@storyscript/contracts';

/**
 * ffprobe JSON → contracts ProbeNormalized, plus the derived flags stored on
 * MediaAsset. Pure: no IO, input is the parsed `-show_format -show_streams`
 * output and is treated as untrusted data.
 */

type Json = Record<string, unknown>;
type MediaKind = MediaAsset['kind'];

const CODEC_TYPES = new Set(['video', 'audio', 'data', 'subtitle', 'attachment']);

function obj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' || s === 'N/A' ? null : s;
}

/** Safe integer from a JSON number or an integer string ("-1024"). */
function int(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Case-insensitive tag lookup (MOV uses `timecode`, some muxers `TIMECODE`). */
function tag(tags: unknown, key: string): string | null {
  const t = obj(tags);
  if (!t) return null;
  for (const [k, v] of Object.entries(t)) if (k.toLowerCase() === key) return str(v);
  return null;
}

/** "1/12800" → {num, den}; null unless both parts are positive safe integers. */
export function parseFfRational(v: unknown): { num: number; den: number } | null {
  const s = str(v);
  const m = s?.match(/^(\d+)\s*[/:]\s*(\d+)$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) return null;
  return { num, den };
}

function rateString(v: unknown): string | null {
  const r = parseFfRational(v);
  return r ? `${r.num}/${r.den}` : null;
}

function normalizeStream(raw: Json): StreamInfo | null {
  const index = int(raw.index);
  const tb = parseFfRational(raw.time_base);
  // A stream without a usable time base can never carry a source_range.
  if (index === null || index < 0 || !tb) return null;
  const type = str(raw.codec_type);
  const width = int(raw.width);
  const height = int(raw.height);
  return {
    index,
    codec_type: (type && CODEC_TYPES.has(type) ? type : 'unknown') as StreamInfo['codec_type'],
    codec_name: str(raw.codec_name),
    profile: str(raw.profile),
    pix_fmt: str(raw.pix_fmt),
    width: width !== null && width > 0 ? width : null,
    height: height !== null && height > 0 ? height : null,
    time_base_num: tb.num,
    time_base_den: tb.den,
    start_pts: int(raw.start_pts),
    duration_ts: int(raw.duration_ts),
    r_frame_rate: rateString(raw.r_frame_rate),
    avg_frame_rate: rateString(raw.avg_frame_rate),
    bits_per_raw_sample: int(raw.bits_per_raw_sample),
  };
}

/**
 * Normalize ffprobe output. Cover-art streams (`disposition.attached_pic`)
 * are dropped: they are not footage and must never be picked as the video
 * stream. Timecode priority: format tags → video stream tags → tmcd data
 * stream → any other stream.
 */
export function normalizeProbe(ffprobeJson: unknown): ProbeNormalized {
  const root = obj(ffprobeJson) ?? {};
  const format = obj(root.format) ?? {};
  const rawStreams = Array.isArray(root.streams) ? root.streams.map(obj).filter((s): s is Json => s !== null) : [];
  const kept = rawStreams.filter((s) => int(obj(s.disposition)?.attached_pic) !== 1);

  const streams: StreamInfo[] = [];
  for (const s of kept) {
    const n = normalizeStream(s);
    if (n) streams.push(n);
  }

  const video = kept.filter((s) => s.codec_type === 'video');
  const tmcd = kept.filter((s) => str(s.codec_tag_string) === 'tmcd' || s.codec_type === 'data');
  const ordered = [...video, ...tmcd, ...kept];
  const firstTag = (key: string): string | null => {
    const fromFormat = tag(format.tags, key);
    if (fromFormat) return fromFormat;
    for (const s of ordered) {
      const v = tag(s.tags, key);
      if (v) return v;
    }
    return null;
  };

  const dur = typeof format.duration === 'number' ? format.duration : Number(str(format.duration) ?? NaN);
  return {
    format_name: str(format.format_name) ?? 'unknown',
    duration_s: Number.isFinite(dur) && dur >= 0 ? dur : null,
    streams,
    timecode: firstTag('timecode'),
    creation_time: firstTag('creation_time'),
  };
}

/** File extensions a folder scan picks up (the server scan and the browser folder walk). */
export const MEDIA_EXTS: ReadonlySet<string> = new Set(['mp4', 'mov', 'm4v', 'mxf', 'mts', 'avi', 'wav', 'mp3', 'aac', 'jpg', 'jpeg', 'png']);

/** Where a poster frame is taken: half the clip, at most 1 s in (stills: 0). */
export function posterSeconds(a: { kind: MediaKind; probe: ProbeNormalized | null }): number {
  if (a.kind !== 'video') return 0;
  const d = a.probe?.duration_s ?? 0;
  return Math.max(0, Math.min(1, d / 2));
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'heic', 'heif', 'webp', 'bmp', 'dng']);
const AUDIO_EXTS = new Set(['wav', 'bwf', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'flac']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'mxf', 'mkv', 'avi', 'mts', 'm2ts', 'webm']);
const DIRECT_PLAY_EXTS = new Set(['mp4', 'mov', 'm4v']);
const DIRECT_PLAY_PIX = new Set(['yuv420p', 'yuvj420p']);

/** Relative frame-rate difference above which a stream is VFR-suspect. */
export const VFR_TOLERANCE = 0.005;

export interface MediaFlags {
  video_stream_index: number | null;
  playable_direct: boolean;
  is_vfr_suspect: boolean;
  has_timecode: boolean;
  kind: MediaKind;
}

function normExt(ext: string): string {
  return ext.trim().replace(/^\./, '').toLowerCase();
}

function kindFromExt(ext: string): MediaKind {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'other';
}

function rateValue(r: string | null): number | null {
  const p = parseFfRational(r);
  return p ? p.num / p.den : null;
}

/** true when either rate is missing, or they differ by more than 0.5%. */
export function isVfrSuspect(s: Pick<StreamInfo, 'r_frame_rate' | 'avg_frame_rate'>): boolean {
  const r = rateValue(s.r_frame_rate);
  const avg = rateValue(s.avg_frame_rate);
  if (r === null || avg === null) return true;
  return Math.abs(r - avg) / Math.max(r, avg) > VFR_TOLERANCE;
}

/** First footage video stream, or null. */
export function pickVideoStream(probe: ProbeNormalized): StreamInfo | null {
  return probe.streams.find((s) => s.codec_type === 'video') ?? null;
}

/**
 * Flags stored on MediaAsset. `playable_direct` is the only gate for Range
 * playback in Chromium: MP4/MOV/M4V container + H.264 + 8-bit 4:2:0.
 * Without a probe (ffprobe failed/missing) only `kind` is guessed from the
 * extension and every capability flag is false.
 */
export function deriveMediaFlags(probe: ProbeNormalized | null, fileExt: string): MediaFlags {
  const ext = normExt(fileExt);
  if (!probe) {
    return { video_stream_index: null, playable_direct: false, is_vfr_suspect: false, has_timecode: false, kind: kindFromExt(ext) };
  }
  const has_timecode = probe.timecode !== null;
  const formats = probe.format_name.split(',');
  const isStill = probe.format_name === 'image2' || formats.some((f) => f.endsWith('_pipe'));
  const video = pickVideoStream(probe);

  if (isStill || IMAGE_EXTS.has(ext)) {
    return { video_stream_index: null, playable_direct: false, is_vfr_suspect: false, has_timecode, kind: 'image' };
  }
  if (!video) {
    const hasAudio = probe.streams.some((s) => s.codec_type === 'audio');
    const kind: MediaKind = hasAudio ? 'audio' : IMAGE_EXTS.has(ext) ? 'image' : 'other';
    return { video_stream_index: null, playable_direct: false, is_vfr_suspect: false, has_timecode, kind };
  }

  const isoContainer = formats.includes('mov') || formats.includes('mp4');
  const eightBit = video.bits_per_raw_sample === null || video.bits_per_raw_sample === 8;
  const playable_direct =
    DIRECT_PLAY_EXTS.has(ext) &&
    isoContainer &&
    video.codec_name === 'h264' &&
    video.pix_fmt !== null &&
    DIRECT_PLAY_PIX.has(video.pix_fmt) &&
    eightBit;

  return {
    video_stream_index: video.index,
    playable_direct,
    is_vfr_suspect: isVfrSuspect(video),
    has_timecode,
    kind: 'video',
  };
}

export interface WholeAssetRange {
  range: SourceRange;
  /** false when start_pts or duration_ts had to be estimated */
  exact: boolean;
}

/**
 * Whole-clip source_range `[start_pts, start_pts + duration_ts)` on the given
 * stream, in that stream's own time base. Missing duration_ts falls back to
 * round(format duration × den / num) and missing start_pts to 0, both with
 * `exact: false`. Returns null when no non-empty safe range can be formed.
 */
export function wholeAssetSourceRange(probe: ProbeNormalized, streamIndex: number): WholeAssetRange | null {
  const s = probe.streams.find((x) => x.index === streamIndex);
  if (!s) return null;
  let exact = true;

  let start = s.start_pts;
  if (start === null) {
    start = 0;
    exact = false;
  }

  let dur = s.duration_ts !== null && s.duration_ts > 0 ? s.duration_ts : null;
  if (dur === null) {
    exact = false;
    if (probe.duration_s === null) return null;
    dur = Math.round((probe.duration_s * s.time_base_den) / s.time_base_num);
  }

  const out = start + dur;
  if (!(dur > 0) || !Number.isSafeInteger(out)) return null;
  return {
    range: {
      stream_index: s.index,
      in_pts: start,
      out_pts: out,
      time_base_num: s.time_base_num,
      time_base_den: s.time_base_den,
    },
    exact,
  };
}
