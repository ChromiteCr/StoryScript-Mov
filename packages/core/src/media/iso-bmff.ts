import type { ProbeNormalized } from '@storyscript/contracts';
import { normalizeProbe } from './probe-normalize.ts';

/**
 * MP4 / MOV facts from the file bytes alone, so a browser can probe a local
 * clip that is never uploaded. The result is built as the JSON that
 * `ffprobe -show_format -show_streams` prints and handed to the same
 * `normalizeProbe()` the server uses, so both paths agree field by field.
 *
 * Written from the public specifications: ISO/IEC 14496-12 (box structure,
 * sample tables, edit lists), ISO/IEC 14496-15 (avcC, hvcC), ISO/IEC 14496-1
 * and 14496-3 (esds descriptors, AudioSpecificConfig), ITU-T H.264 §7.3.2.1
 * (SPS syntax), SMPTE RDD 36 (ProRes frame header) and Apple's QuickTime File
 * Format documentation (sound description v1/v2, tmcd sample description).
 *
 * Pure: all I/O goes through the injected `ReadAt`. Only box headers are read
 * while scanning the top level, then the whole `moov`; media payload is never
 * read except the 4-byte frame counter of a tmcd track and the first 26 bytes
 * of a 4444-class ProRes frame. Never throws.
 *
 * Not covered: fragmented MP4 (samples described only in `moof` boxes) comes
 * back with null durations and frame rates; compressed `cmov` headers fail.
 */

/** Reads `length` bytes at `offset`; may return fewer bytes at end of file. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

export type IsoProbeResult =
  | { ok: true; probe: ProbeNormalized }
  | { ok: false; reason: 'not_iso' | 'no_moov' | 'too_large' | 'malformed'; detail: string };

/** Largest `moov` box read into memory. */
export const ISO_MAX_MOOV_BYTES = 256 * 1024 * 1024;

const MAX_TOP_LEVEL_BOXES = 100_000;
const FORMAT_NAME = 'mov,mp4,m4a,3gp,3g2,mj2';
/** Seconds between 1904-01-01 (QuickTime epoch) and 1970-01-01. */
const MAC_EPOCH_OFFSET = 2_082_844_800;
const TWO_32 = 4_294_967_296;
const INT_MAX = 2_147_483_647;
/** Samples looked at for the smallest composition time of a track without edit list. */
const MIN_PTS_WINDOW = 256;

/** Box types a QuickTime file without `ftyp` may start with. */
const QT_FIRST_BOXES = new Set(['moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'junk']);

class IsoError extends Error {}

function fail(detail: string): never {
  throw new IsoError(detail);
}

// ---------------------------------------------------------------- bytes

function need(b: Uint8Array, off: number, n: number): void {
  if (!(off >= 0 && n >= 0 && off + n <= b.length)) fail(`${n} bytes at ${off} are outside a ${b.length}-byte buffer`);
}

function u8(b: Uint8Array, o: number): number {
  need(b, o, 1);
  return b[o]!;
}

function u16(b: Uint8Array, o: number): number {
  need(b, o, 2);
  return (b[o]! << 8) | b[o + 1]!;
}

function u32(b: Uint8Array, o: number): number {
  need(b, o, 4);
  return b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
}

function i32(b: Uint8Array, o: number): number {
  return u32(b, o) | 0;
}

/** Unsigned 64-bit; null when it does not fit a safe integer (e.g. all-ones "unknown"). */
function u64(b: Uint8Array, o: number): number | null {
  const v = u32(b, o) * TWO_32 + u32(b, o + 4);
  return Number.isSafeInteger(v) ? v : null;
}

function i64(b: Uint8Array, o: number): number | null {
  const v = i32(b, o) * TWO_32 + u32(b, o + 4);
  return Number.isSafeInteger(v) ? v : null;
}

function fourcc(b: Uint8Array, o: number): string {
  need(b, o, 4);
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

function printableType(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (!((c >= 0x20 && c <= 0x7e) || c === 0xa9)) return false;
  }
  return true;
}

/** Four-cc as ffprobe prints `codec_tag_string`: non-printable bytes as `[n]`. */
function tagString(t: string): string {
  let s = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    s += c > 0x20 && c < 0x7f ? t[i] : c === 0x20 ? ' ' : `[${c}]`;
  }
  return s;
}

// ---------------------------------------------------------------- boxes

interface Box {
  type: string;
  /** first byte of the header */
  start: number;
  /** first byte after the header */
  body: number;
  /** one past the last byte */
  end: number;
}

/**
 * Child boxes of `[from, to)`. Lenient like real demuxers: parsing stops at the
 * first header that does not fit (QuickTime pads some containers with zeros).
 */
function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size: number | null = u32(b, o);
    const type = fourcc(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > to) break;
      size = u64(b, o + 8);
      hdr = 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size === null || size < hdr || o + size > to) break;
    out.push({ type, start: o, body: o + hdr, end: o + size });
    o += size;
  }
  return out;
}

function kid(boxes: Box[], type: string): Box | undefined {
  return boxes.find((x) => x.type === type);
}

function kidsOf(b: Uint8Array, box: Box | undefined): Box[] {
  return box ? children(b, box.body, box.end) : [];
}

/**
 * Children of a sample entry whose fixed part has a version-dependent length.
 * Tries each candidate offset and keeps the first that tiles the rest of the
 * entry with plausible boxes.
 */
function entryChildren(b: Uint8Array, entry: Box, offsets: number[]): Box[] {
  for (const off of offsets) {
    const start = entry.body + off;
    if (start > entry.end) continue;
    const list = children(b, start, entry.end);
    const last = list[list.length - 1];
    const covered = last ? last.end : start;
    const tidy = list.every((x) => printableType(x.type) || x.type === '\0\0\0\0');
    if (list.length > 0 && tidy && entry.end - covered < 8) return list;
  }
  return [];
}

// ---------------------------------------------------------------- bit reader (exp-Golomb)

class Bits {
  private pos = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.bytes.length * 8) fail('bitstream ends early');
      v = v * 2 + ((this.bytes[this.pos >> 3]! >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) fail('exp-Golomb code too long');
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }

  left(): number {
    return this.bytes.length * 8 - this.pos;
  }
}

/** NAL payload → RBSP: drops each emulation-prevention 0x03 that follows two zero bytes. */
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const v = nal[i]!;
    if (zeros >= 2 && v === 3) {
      zeros = 0;
      continue;
    }
    out[n++] = v;
    zeros = v === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

// ---------------------------------------------------------------- codecs

interface CodecInfo {
  name: string | null;
  profile: string | null;
  pixFmt: string | null;
  bits: number | null;
  width: number | null;
  height: number | null;
  /** 4444-class ProRes: pixel format depends on the first frame header */
  proresDeep?: boolean;
}

const NO_CODEC: CodecInfo = { name: null, profile: null, pixFmt: null, bits: null, width: null, height: null };

function planarName(chroma: number, depth: number, fullRange: boolean, rgb: boolean): string | null {
  const suffix = depth === 8 ? '' : `${depth}le`;
  if (depth < 8 || depth > 16) return null;
  if (chroma === 0) return depth === 8 ? 'gray' : `gray${depth}le`;
  if (chroma === 3 && rgb) return `gbrp${suffix}`;
  const sub = chroma === 1 ? '420' : chroma === 2 ? '422' : chroma === 3 ? '444' : null;
  if (!sub) return null;
  return depth === 8 && fullRange ? `yuvj${sub}p` : `yuv${sub}p${suffix}`;
}

interface AvcSps {
  profileIdc: number;
  constraints: number;
  chroma: number;
  depth: number;
  width: number;
  height: number;
  fullRange: boolean;
  matrix: number | null;
}

const AVC_HIGH_SYNTAX = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: Bits, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** H.264 seq_parameter_set_rbsp up to the VUI signal-type fields. */
function parseAvcSps(nal: Uint8Array): AvcSps {
  if (nal.length < 4 || (nal[0]! & 0x1f) !== 7) fail('avcC holds no SPS');
  const r = new Bits(unescapeRbsp(nal.subarray(1)));
  const profileIdc = r.u(8);
  const constraints = r.u(8);
  r.u(8); // level_idc
  r.ue(); // seq_parameter_set_id
  let chroma = 1;
  let depth = 8;
  let separatePlanes = 0;
  if (AVC_HIGH_SYNTAX.has(profileIdc)) {
    chroma = r.ue();
    if (chroma > 3) fail('bad chroma_format_idc');
    if (chroma === 3) separatePlanes = r.u(1);
    depth = r.ue() + 8;
    r.ue(); // bit_depth_chroma_minus8
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) {
      const lists = chroma !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const cycle = r.ue();
    if (cycle > 255) fail('bad num_ref_frames_in_pic_order_cnt_cycle');
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1); // direct_8x8_inference_flag
  let cropL = 0;
  let cropR = 0;
  let cropT = 0;
  let cropB = 0;
  if (r.u(1)) {
    cropL = r.ue();
    cropR = r.ue();
    cropT = r.ue();
    cropB = r.ue();
  }
  let fullRange = false;
  let matrix: number | null = null;
  try {
    if (r.left() > 0 && r.u(1)) {
      if (r.u(1) && r.u(8) === 255) r.u(32); // aspect_ratio_idc == Extended_SAR
      if (r.u(1)) r.u(1); // overscan
      if (r.u(1)) {
        r.u(3); // video_format
        fullRange = r.u(1) === 1;
        if (r.u(1)) {
          r.u(16); // colour_primaries, transfer_characteristics
          matrix = r.u(8);
        }
      }
    }
  } catch {
    // A truncated VUI keeps the defaults: limited range, unknown matrix.
  }
  const arrayType = separatePlanes ? 0 : chroma;
  const subW = arrayType === 1 || arrayType === 2 ? 2 : 1;
  const subH = arrayType === 1 ? 2 : 1;
  const unitX = arrayType === 0 ? 1 : subW;
  const unitY = (arrayType === 0 ? 1 : subH) * (2 - frameMbsOnly);
  return {
    profileIdc,
    constraints,
    chroma,
    depth,
    width: widthMbs * 16 - unitX * (cropL + cropR),
    height: (2 - frameMbsOnly) * heightUnits * 16 - unitY * (cropT + cropB),
    fullRange,
    matrix,
  };
}

function avcProfileName(idc: number, constraints: number): string | null {
  const set1 = (constraints >> 6) & 1;
  const set3 = (constraints >> 4) & 1;
  switch (idc) {
    case 66:
      return set1 ? 'Constrained Baseline' : 'Baseline';
    case 77:
      return 'Main';
    case 88:
      return 'Extended';
    case 100:
      return 'High';
    case 110:
      return set3 ? 'High 10 Intra' : 'High 10';
    case 122:
      return set3 ? 'High 4:2:2 Intra' : 'High 4:2:2';
    case 244:
      return set3 ? 'High 4:4:4 Intra' : 'High 4:4:4 Predictive';
    case 144:
      return 'High 4:4:4';
    case 44:
      return 'CAVLC 4:4:4';
    case 118:
      return 'Multiview High';
    case 128:
      return 'Stereo High';
    default:
      return null;
  }
}

function parseAvcC(b: Uint8Array, box: Box | undefined): CodecInfo {
  const info: CodecInfo = { ...NO_CODEC, name: 'h264' };
  if (!box) return info;
  const p = box.body;
  const profileInd = u8(b, p + 1);
  const compat = u8(b, p + 2);
  const spsCount = u8(b, p + 5) & 0x1f;
  let q = p + 6;
  let sps: AvcSps | null = null;
  for (let i = 0; i < spsCount; i++) {
    const len = u16(b, q);
    need(b, q + 2, len);
    if (!sps) {
      try {
        sps = parseAvcSps(b.subarray(q + 2, q + 2 + len));
      } catch {
        sps = null;
      }
    }
    q += 2 + len;
  }
  let extChroma: number | null = null;
  let extDepth: number | null = null;
  if (q < box.end) {
    const ppsCount = u8(b, q);
    q += 1;
    for (let i = 0; i < ppsCount && q + 2 <= box.end; i++) q += 2 + u16(b, q);
    if ([100, 110, 122, 144].includes(profileInd) && q + 3 <= box.end) {
      extChroma = u8(b, q) & 3;
      extDepth = (u8(b, q + 1) & 7) + 8;
    }
  }
  if (sps) {
    info.profile = avcProfileName(sps.profileIdc, sps.constraints);
    info.pixFmt = planarName(sps.chroma, sps.depth, sps.fullRange, sps.matrix === 0);
    info.bits = sps.depth;
    if (sps.width > 0 && sps.height > 0) {
      info.width = sps.width;
      info.height = sps.height;
    }
  } else {
    info.profile = avcProfileName(profileInd, compat);
    const chroma = extChroma ?? (AVC_HIGH_SYNTAX.has(profileInd) ? null : 1);
    const depth = extDepth ?? (AVC_HIGH_SYNTAX.has(profileInd) ? null : 8);
    if (chroma !== null && depth !== null) {
      info.pixFmt = planarName(chroma, depth, false, false);
      info.bits = depth;
    }
  }
  return info;
}

const HEVC_PROFILES: Record<number, string> = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Rext' };

function parseHvcC(b: Uint8Array, box: Box | undefined): CodecInfo {
  const info: CodecInfo = { ...NO_CODEC, name: 'hevc' };
  if (!box) return info;
  const p = box.body;
  let idc = u8(b, p + 1) & 0x1f;
  if (!HEVC_PROFILES[idc]) {
    const compat = u32(b, p + 2);
    for (let j = 1; j <= 4; j++) {
      if ((compat >>> (31 - j)) & 1) {
        idc = j;
        break;
      }
    }
  }
  info.profile = HEVC_PROFILES[idc] ?? null;
  const chroma = u8(b, p + 16) & 3;
  const depth = (u8(b, p + 17) & 7) + 8;
  info.pixFmt = planarName(chroma, depth, false, false);
  // ffprobe leaves bits_per_raw_sample unset for HEVC in MP4/MOV.
  return info;
}

const PRORES: Record<string, { profile: string; deep: boolean }> = {
  apco: { profile: 'Proxy', deep: false },
  apcs: { profile: 'LT', deep: false },
  apcn: { profile: 'Standard', deep: false },
  apch: { profile: 'HQ', deep: false },
  ap4h: { profile: '4444', deep: true },
  ap4x: { profile: 'XQ', deep: true },
};

/** ProRes pixel format from the frame header (RDD 36): chroma at byte 20, alpha at byte 25. */
function proresPixFmt(deep: boolean, header: Uint8Array | null): string {
  let chroma = deep ? 3 : 2;
  let alpha = false;
  if (header && header.length >= 26 && fourcc(header, 4) === 'icpf') {
    const c = header[20]! >> 6;
    if (c === 2 || c === 3) chroma = c;
    alpha = (header[25]! & 0x0f) !== 0;
  }
  const depth = deep ? 12 : 10;
  if (chroma === 3) return alpha ? `yuva444p${depth}le` : `yuv444p${depth}le`;
  return `yuv422p${depth}le`;
}

const VIDEO_TAGS: Record<string, string> = {
  avc1: 'h264', avc2: 'h264', avc3: 'h264', avc4: 'h264', dva1: 'h264', dvav: 'h264',
  hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
  av01: 'av1', vp08: 'vp8', vp09: 'vp9', mp4v: 'mpeg4',
  jpeg: 'mjpeg', mjpa: 'mjpeg', mjpb: 'mjpegb', 'png ': 'png',
  AVdn: 'dnxhd', AVdh: 'dnxhd', AVd1: 'dnxhd',
  'dvc ': 'dvvideo', dvcp: 'dvvideo', dvpp: 'dvvideo', dv5n: 'dvvideo', dv5p: 'dvvideo',
  dvh5: 'dvvideo', dvh6: 'dvvideo', dvhq: 'dvvideo', dvhp: 'dvvideo',
  mp2v: 'mpeg2video', m2v1: 'mpeg2video', mp1v: 'mpeg1video', m1v1: 'mpeg1video',
  v210: 'v210', 'raw ': 'rawvideo', '2vuy': 'rawvideo', yuv2: 'rawvideo',
  h263: 'h263', s263: 'h263', CFHD: 'cfhd', cvid: 'cinepak',
};

function videoCodecName(tag: string): string | null {
  if (VIDEO_TAGS[tag]) return VIDEO_TAGS[tag]!;
  if (PRORES[tag]) return 'prores';
  if (/^(xd[v5h][0-9a-z]|mx[3-5][np]|hdv[1-9a])$/.test(tag)) return 'mpeg2video';
  return null;
}

/** ES_Descriptor inside esds → objectTypeIndication and DecoderSpecificInfo bytes. */
function parseEsds(b: Uint8Array, box: Box): { oti: number; dsi: Uint8Array | null } | null {
  let p = box.body + 4; // FullBox
  const end = box.end;
  const descriptor = (at: number): { tag: number; body: number; end: number } | null => {
    if (at + 2 > end) return null;
    const tag = u8(b, at);
    let len = 0;
    let q = at + 1;
    for (let i = 0; i < 4; i++) {
      const c = u8(b, q++);
      len = len * 128 + (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, body: q, end: Math.min(q + len, end) };
  };
  const es = descriptor(p);
  if (!es || es.tag !== 0x03) return null;
  p = es.body + 2; // ES_ID
  const flags = u8(b, p++);
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + u8(b, p); // URL
  if (flags & 0x20) p += 2; // OCR_ES_Id
  while (p < es.end) {
    const d = descriptor(p);
    if (!d) break;
    if (d.tag === 0x04) {
      const oti = u8(b, d.body);
      let dsi: Uint8Array | null = null;
      const inner = descriptor(d.body + 13);
      if (inner && inner.tag === 0x05 && inner.end > inner.body) dsi = b.subarray(inner.body, inner.end);
      return { oti, dsi };
    }
    p = d.end;
  }
  return null;
}

const AAC_PROFILES: Record<number, string> = { 1: 'Main', 2: 'LC', 3: 'SSR', 4: 'LTP', 5: 'HE-AAC', 23: 'LD', 29: 'HE-AACv2', 39: 'ELD' };

/**
 * AAC profile from AudioSpecificConfig (14496-3 §1.6.2.1). Besides the
 * explicit object type, an LC config may announce SBR (HE-AAC) and PS
 * (HE-AACv2) through the backward-compatible sync extensions 0x2b7 / 0x548.
 */
export function aacProfileFromConfig(dsi: Uint8Array | null): string | null {
  if (!dsi || dsi.length < 2) return null;
  let base: string | null = null;
  try {
    const r = new Bits(dsi);
    let aot = r.u(5);
    if (aot === 31) aot = 32 + r.u(6);
    base = AAC_PROFILES[aot] ?? null;
    if (aot !== 2) return base;
    if (r.u(4) === 15) r.u(24); // samplingFrequencyIndex
    const channels = r.u(4);
    if (channels === 0) return base; // program_config_element: not walked
    r.u(1); // frameLengthFlag
    if (r.u(1)) r.u(14); // dependsOnCoreCoder → coreCoderDelay
    if (r.u(1)) r.u(1); // extensionFlag → extensionFlag3
    if (r.left() < 16 || r.u(11) !== 0x2b7 || r.u(5) !== 5 || r.u(1) !== 1) return base;
    if (r.u(4) === 15) r.u(24); // extensionSamplingFrequencyIndex
    if (r.left() >= 12 && r.u(11) === 0x548 && r.u(1) === 1) return 'HE-AACv2';
    return 'HE-AAC';
  } catch {
    return base;
  }
}

function mp4aCodec(oti: number | null): string | null {
  if (oti === null || oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) return 'aac';
  if (oti === 0x69 || oti === 0x6b) return 'mp3';
  if (oti === 0xa5) return 'ac3';
  if (oti === 0xa6) return 'eac3';
  if (oti === 0xa9) return 'dts';
  if (oti === 0xad) return 'opus';
  if (oti === 0xdd) return 'vorbis';
  return null;
}

const AUDIO_TAGS: Record<string, string> = {
  ulaw: 'pcm_mulaw', alaw: 'pcm_alaw', 'ac-3': 'ac3', 'ec-3': 'eac3', alac: 'alac', Opus: 'opus', fLaC: 'flac',
  '.mp3': 'mp3', samr: 'amr_nb', sawb: 'amr_wb', ima4: 'adpcm_ima_qt', mlpa: 'truehd',
  dtsc: 'dts', dtsh: 'dts', dtsl: 'dts', dtse: 'dts', 'raw ': 'pcm_u8',
};

function pcmName(float: boolean, signed: boolean, bits: number, little: boolean): string | null {
  if (float) return bits === 32 || bits === 64 ? `pcm_f${bits}${little ? 'le' : 'be'}` : null;
  if (bits === 8) return signed ? 'pcm_s8' : 'pcm_u8';
  if (![16, 24, 32].includes(bits)) return null;
  return `pcm_${signed ? 's' : 'u'}${bits}${little ? 'le' : 'be'}`;
}

/** ffprobe reports bits_per_raw_sample only for 24/32-bit integer PCM. */
function pcmBits(name: string | null): number | null {
  const m = name?.match(/^pcm_[su](24|32)[lb]e$/);
  return m ? Number(m[1]) : null;
}

function parseSound(b: Uint8Array, entry: Box, tag: string): CodecInfo {
  const version = u16(b, entry.body + 8);
  const sampleSize = u16(b, entry.body + 18);
  const offsets = version === 1 ? [44, 28] : version === 2 ? [64, 28] : [28, 44, 64];
  const list = entryChildren(b, entry, offsets);
  const wave = kidsOf(b, kid(list, 'wave'));
  const esdsBox = kid(list, 'esds') ?? kid(wave, 'esds');
  const enda = kid(wave, 'enda') ?? kid(list, 'enda');
  const little = enda ? (enda.end - enda.body >= 2 ? u16(b, enda.body) : u8(b, enda.body)) !== 0 : false;

  let name: string | null = null;
  let profile: string | null = null;
  switch (tag) {
    case 'mp4a': {
      const es = esdsBox ? parseEsds(b, esdsBox) : null;
      name = mp4aCodec(es?.oti ?? null);
      if (name === 'aac') {
        const oti = es?.oti ?? 0x40;
        profile = oti === 0x66 ? 'Main' : oti === 0x67 ? 'LC' : oti === 0x68 ? 'SSR' : aacProfileFromConfig(es?.dsi ?? null);
      }
      break;
    }
    case 'sowt':
      name = sampleSize === 8 ? 'pcm_s8' : 'pcm_s16le';
      break;
    case 'twos':
      name = sampleSize === 8 ? 'pcm_s8' : 'pcm_s16be';
      break;
    case 'in24':
      name = little ? 'pcm_s24le' : 'pcm_s24be';
      break;
    case 'in32':
      name = little ? 'pcm_s32le' : 'pcm_s32be';
      break;
    case 'fl32':
      name = little ? 'pcm_f32le' : 'pcm_f32be';
      break;
    case 'fl64':
      name = little ? 'pcm_f64le' : 'pcm_f64be';
      break;
    case 'lpcm': {
      if (version === 2) {
        const bits = u32(b, entry.body + 48);
        const flags = u32(b, entry.body + 52);
        name = pcmName((flags & 1) !== 0, (flags & 4) !== 0, bits, (flags & 2) === 0);
      }
      break;
    }
    case 'ipcm':
    case 'fpcm': {
      const pcmC = kid(list, 'pcmC');
      if (pcmC) {
        const flags = u8(b, pcmC.body + 4);
        const bits = u8(b, pcmC.body + 5);
        name = pcmName(tag === 'fpcm', true, bits, (flags & 1) !== 0);
      }
      break;
    }
    default:
      name = AUDIO_TAGS[tag] ?? null;
  }
  return { ...NO_CODEC, name, profile, bits: pcmBits(name) };
}

function parseVisual(b: Uint8Array, entry: Box, tag: string): CodecInfo {
  const width = u16(b, entry.body + 24);
  const height = u16(b, entry.body + 26);
  const list = entryChildren(b, entry, [78]);
  let info: CodecInfo;
  const name = videoCodecName(tag);
  if (name === 'h264') info = parseAvcC(b, kid(list, 'avcC'));
  else if (name === 'hevc') info = parseHvcC(b, kid(list, 'hvcC'));
  else if (name === 'prores') {
    const pr = PRORES[tag]!;
    info = { ...NO_CODEC, name, profile: pr.profile, pixFmt: proresPixFmt(pr.deep, null), bits: pr.deep ? 12 : 10, proresDeep: pr.deep };
  } else if (name === 'mpeg4' && kid(list, 'esds')) {
    const es = parseEsds(b, kid(list, 'esds')!);
    const oti = es?.oti ?? 0x20;
    const byOti = oti >= 0x60 && oti <= 0x65 ? 'mpeg2video' : oti === 0x6a ? 'mpeg1video' : oti === 0x6c ? 'mjpeg' : 'mpeg4';
    info = { ...NO_CODEC, name: byOti };
  } else info = { ...NO_CODEC, name };
  if (info.width === null && width > 0 && height > 0) {
    info.width = width;
    info.height = height;
  }
  return info;
}

const SUBTITLE_TAGS: Record<string, string> = { tx3g: 'mov_text', text: 'mov_text', c608: 'eia_608', wvtt: 'webvtt', stpp: 'ttml' };

// ---------------------------------------------------------------- tracks

interface Tmcd {
  flags: number;
  timescale: number;
  frameDuration: number;
  frames: number;
}

interface Track {
  handler: string | null;
  tag: string | null;
  timescale: number;
  creation: number | null;
  edits: { duration: number; mediaTime: number }[] | null;
  sampleCount: number;
  sttsSum: number;
  commonDelta: number | null;
  minPts: number;
  codec: CodecInfo;
  tmcd: Tmcd | null;
  firstSample: number | null;
  timecode: string | null;
}

/** mvhd / mdhd: creation time, timescale and duration (versions 0 and 1). */
function parseHeader(b: Uint8Array, box: Box): { creation: number | null; timescale: number; duration: number | null } {
  const v = u8(b, box.body);
  const p = box.body + 4;
  if (v === 1) {
    const duration = u64(b, p + 20);
    return { creation: u64(b, p), timescale: u32(b, p + 16), duration };
  }
  const d = u32(b, p + 12);
  return { creation: u32(b, p), timescale: u32(b, p + 8), duration: d === 0xffffffff ? null : d };
}

function parseElst(b: Uint8Array, box: Box): { duration: number; mediaTime: number }[] {
  const v = u8(b, box.body);
  const n = u32(b, box.body + 4);
  const size = v === 1 ? 20 : 12;
  need(b, box.body + 8, n * size);
  const out: { duration: number; mediaTime: number }[] = [];
  for (let i = 0, p = box.body + 8; i < n && i < 10_000; i++, p += size) {
    const duration = v === 1 ? u64(b, p) : u32(b, p);
    const mediaTime = v === 1 ? i64(b, p + 8) : i32(b, p + 4);
    if (duration === null || mediaTime === null) fail('edit list entry out of range');
    out.push({ duration, mediaTime });
  }
  return out;
}

/** stts totals, the most common sample delta, and (with ctts) the smallest early composition time. */
function parseTiming(
  b: Uint8Array,
  stts: Box | undefined,
  ctts: Box | undefined,
): { count: number; sum: number; commonDelta: number | null; minPts: number } {
  let count = 0;
  let sum = 0;
  const hist = new Map<number, number>();
  const sttsN = stts ? u32(b, stts.body + 4) : 0;
  if (stts) need(b, stts.body + 8, sttsN * 8);
  for (let i = 0, p = (stts?.body ?? 0) + 8; i < sttsN; i++, p += 8) {
    const c = u32(b, p);
    const d = u32(b, p + 4);
    count += c;
    sum += c * d;
    if (c > 0) hist.set(d, (hist.get(d) ?? 0) + c);
  }
  if (!Number.isSafeInteger(sum)) fail('stts total overflows');
  let commonDelta: number | null = null;
  let best = 0;
  for (const [d, c] of hist) {
    if (d > 0 && (c > best || (c === best && commonDelta !== null && d < commonDelta))) {
      best = c;
      commonDelta = d;
    }
  }

  let minPts = 0;
  if (stts && ctts) {
    const cttsN = u32(b, ctts.body + 4);
    need(b, ctts.body + 8, cttsN * 8);
    let si = 0;
    let sLeft = 0;
    let delta = 0;
    let ci = 0;
    let cLeft = 0;
    let offset = 0;
    let dts = 0;
    let min = Infinity;
    for (let k = 0; k < MIN_PTS_WINDOW; k++) {
      while (sLeft === 0 && si < sttsN) {
        sLeft = u32(b, stts.body + 8 + si * 8);
        delta = u32(b, stts.body + 12 + si * 8);
        si++;
      }
      if (sLeft === 0) break;
      while (cLeft === 0 && ci < cttsN) {
        cLeft = u32(b, ctts.body + 8 + ci * 8);
        offset = i32(b, ctts.body + 12 + ci * 8);
        ci++;
      }
      if (cLeft === 0) offset = 0;
      min = Math.min(min, dts + offset);
      dts += delta;
      sLeft--;
      if (cLeft > 0) cLeft--;
    }
    if (Number.isFinite(min)) minPts = min;
  }
  return { count, sum, commonDelta, minPts };
}

function sampleCount(b: Uint8Array, stbl: Box[]): number | null {
  const stsz = kid(stbl, 'stsz') ?? kid(stbl, 'stz2');
  return stsz ? u32(b, stsz.body + 8) : null;
}

/** File offset of the first sample: the first chunk that holds any samples. */
function firstSampleOffset(b: Uint8Array, stbl: Box[]): number | null {
  const stco = kid(stbl, 'stco');
  const co64 = kid(stbl, 'co64');
  const table = stco ?? co64;
  if (!table) return null;
  const chunks = u32(b, table.body + 4);
  let chunk = 0;
  const stsc = kid(stbl, 'stsc');
  if (stsc) {
    const n = u32(b, stsc.body + 4);
    need(b, stsc.body + 8, n * 12);
    chunk = -1;
    for (let i = 0; i < n; i++) {
      const first = u32(b, stsc.body + 8 + i * 12);
      const perChunk = u32(b, stsc.body + 12 + i * 12);
      if (perChunk > 0 && first >= 1) {
        chunk = first - 1;
        break;
      }
    }
  }
  if (chunk < 0 || chunk >= chunks) return null;
  return stco ? u32(b, stco.body + 8 + chunk * 4) : u64(b, co64!.body + 8 + chunk * 8);
}

function parseTmcd(b: Uint8Array, entry: Box): Tmcd {
  const p = entry.body;
  return { flags: u32(b, p + 12), timescale: u32(b, p + 16), frameDuration: u32(b, p + 20), frames: u8(b, p + 24) };
}

function parseTrak(b: Uint8Array, trak: Box): Track {
  const list = kidsOf(b, trak);
  const mdia = kidsOf(b, kid(list, 'mdia'));
  const mdhdBox = kid(mdia, 'mdhd');
  const mdhd = mdhdBox ? parseHeader(b, mdhdBox) : null;
  const hdlr = kid(mdia, 'hdlr');
  const handler = hdlr ? fourcc(b, hdlr.body + 8) : null;
  const elst = kid(kidsOf(b, kid(list, 'edts')), 'elst');
  const stbl = kidsOf(b, kid(kidsOf(b, kid(mdia, 'minf')), 'stbl'));

  const stsd = kid(stbl, 'stsd');
  const entry = stsd && u32(b, stsd.body + 4) > 0 ? children(b, stsd.body + 8, stsd.end)[0] : undefined;
  const tag = entry ? entry.type : null;

  let codec: CodecInfo = NO_CODEC;
  let tmcd: Tmcd | null = null;
  if (entry && tag) {
    if (handler === 'vide') codec = parseVisual(b, entry, tag);
    else if (handler === 'soun') codec = parseSound(b, entry, tag);
    else if (tag === 'tmcd') tmcd = parseTmcd(b, entry);
    else codec = { ...NO_CODEC, name: SUBTITLE_TAGS[tag] ?? null };
  }
  if (handler === 'vide' && codec.width === null) {
    const tkhd = kid(list, 'tkhd');
    if (tkhd) {
      const at = tkhd.body + (u8(b, tkhd.body) === 1 ? 88 : 76);
      const w = Math.floor(u32(b, at) / 65536);
      const h = Math.floor(u32(b, at + 4) / 65536);
      if (w > 0 && h > 0) codec = { ...codec, width: w, height: h };
    }
  }

  const timing = parseTiming(b, kid(stbl, 'stts'), kid(stbl, 'ctts'));
  const needsFirst = tmcd !== null || codec.proresDeep === true;
  return {
    handler,
    tag,
    timescale: mdhd?.timescale ?? 0,
    creation: mdhd?.creation ?? null,
    edits: elst ? parseElst(b, elst) : null,
    sampleCount: sampleCount(b, stbl) ?? timing.count,
    sttsSum: timing.sum,
    commonDelta: timing.commonDelta,
    minPts: timing.minPts,
    codec,
    tmcd,
    firstSample: needsFirst ? firstSampleOffset(b, stbl) : null,
    timecode: null,
  };
}

/** Attached pictures (`covr`) in moov/udta/meta/ilst or moov/meta/ilst; ffprobe numbers them as streams. */
function countCoverArt(b: Uint8Array, box: Box): number {
  const metaIn = (list: Box[]): Box[] => {
    const meta = kid(list, 'meta');
    if (!meta) return [];
    // ISO meta is a FullBox; QuickTime meta is a plain container.
    const qt = meta.body + 8 <= meta.end && fourcc(b, meta.body + 4) === 'hdlr';
    return children(b, qt ? meta.body : meta.body + 4, meta.end);
  };
  const scope = box.type === 'udta' ? metaIn(kidsOf(b, box)) : metaIn([box]);
  const ilst = kid(scope, 'ilst');
  if (!ilst) return 0;
  let n = 0;
  for (const item of kidsOf(b, ilst)) {
    if (item.type === 'covr') n += kidsOf(b, item).filter((x) => x.type === 'data').length;
  }
  return n;
}

// ---------------------------------------------------------------- values

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** n/d reduced as ffprobe prints rationals; terms above 2^31-1 fall back to the closest convergent. */
function ratio(num: bigint, den: bigint): string {
  if (num <= 0n || den <= 0n) return '0/0';
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  const max = BigInt(INT_MAX);
  if (n <= max && d <= max) return `${n}/${d}`;
  let [p0, q0, p1, q1] = [0n, 1n, 1n, 0n];
  let [x, y] = [n, d];
  while (y !== 0n) {
    const a = x / y;
    const p2 = a * p1 + p0;
    const q2 = a * q1 + q0;
    if (p2 > max || q2 > max) break;
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    [x, y] = [y, x - a * y];
  }
  return q1 === 0n || p1 === 0n ? '0/0' : `${p1}/${q1}`;
}

/** Average rate: samples per total sample duration (stts), in the media time scale. */
function rateFromSamples(count: number, timescale: number, duration: number): string {
  if (!(count > 0 && timescale > 0 && duration > 0)) return '0/0';
  return ratio(BigInt(count) * BigInt(timescale), BigInt(duration));
}

/** 1904-epoch seconds → ffprobe's `2026-01-02T03:04:05.000000Z`; values below the epoch gap are taken as Unix time. */
function creationString(t: number | null): string | null {
  if (!t) return null;
  const unix = t >= MAC_EPOCH_OFFSET ? t - MAC_EPOCH_OFFSET : t;
  const ms = unix * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** SMPTE timecode from a frame number; drop-frame uses ';' before the frame field. */
export function frameToTimecode(frame: number, fps: number, dropFrame: boolean, wrap24h: boolean): string {
  let f = Math.abs(frame);
  const neg = frame < 0;
  const drop = dropFrame && fps % 30 === 0 ? (fps / 30) * 2 : 0;
  if (drop) {
    const per10 = fps * 600 - drop * 9;
    const perMin = fps * 60 - drop;
    const tens = Math.floor(f / per10);
    const rem = f % per10;
    f += 9 * drop * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
  }
  const ff = f % fps;
  const ss = Math.floor(f / fps) % 60;
  const mm = Math.floor(f / (fps * 60)) % 60;
  let hh = Math.floor(f / (fps * 3600));
  if (wrap24h) hh %= 24;
  return `${neg ? '-' : ''}${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${drop ? ';' : ':'}${pad2(ff)}`;
}

function tmcdTimecode(t: Tmcd, sample: Uint8Array): string | null {
  if (sample.length < 4) return null;
  const fps = t.frames || (t.frameDuration > 0 ? Math.round(t.timescale / t.frameDuration) : 0);
  if (fps <= 0) return null;
  const frame = t.flags & 0x0004 ? i32(sample, 0) : u32(sample, 0);
  return frameToTimecode(frame, fps, (t.flags & 0x0001) !== 0, (t.flags & 0x0002) !== 0);
}

/** start_pts / duration_ts as ffprobe reports them, from the edit list and sample tables. */
function presentation(t: Track, movieTimescale: number): { start: number; duration: number | null } {
  const toMedia = (x: number): number => (movieTimescale > 0 ? Math.round((x * t.timescale) / movieTimescale) : 0);
  if (t.edits && t.edits.length > 0) {
    let empty = 0;
    let used = 0;
    let seen = false;
    for (const e of t.edits) {
      if (e.mediaTime === -1) {
        if (!seen) empty += e.duration;
        continue;
      }
      seen = true;
      used += e.duration;
    }
    const edited = toMedia(used);
    const duration = t.sttsSum > 0 ? (edited > 0 ? Math.min(edited, t.sttsSum) : t.sttsSum) : edited;
    return { start: toMedia(empty), duration: duration > 0 ? duration : null };
  }
  return { start: t.minPts, duration: t.sttsSum > 0 ? t.sttsSum : null };
}

const CODEC_TYPES: Record<string, string> = {
  vide: 'video',
  soun: 'audio',
  tmcd: 'data',
  meta: 'data',
  text: 'subtitle',
  sbtl: 'subtitle',
  subt: 'subtitle',
  clcp: 'subtitle',
  subp: 'subtitle',
};

function streamJson(t: Track, index: number, movieTimescale: number): Record<string, unknown> {
  const type = t.handler ? (CODEC_TYPES[t.handler] ?? 'data') : 'data';
  const { start, duration } = presentation(t, movieTimescale);
  let r = '0/0';
  let avg = '0/0';
  if (type === 'video') {
    if (t.commonDelta && t.timescale > 0) r = ratio(BigInt(t.timescale), BigInt(t.commonDelta));
    avg = rateFromSamples(t.sampleCount, t.timescale, t.sttsSum);
  } else if (t.tmcd) {
    avg = t.tmcd.timescale > 0 && t.tmcd.frameDuration > 0 ? `${t.tmcd.timescale}/${t.tmcd.frameDuration}` : '0/0';
  }
  const tags: Record<string, string> = {};
  const created = creationString(t.creation);
  if (created) tags.creation_time = created;
  if (t.timecode) tags.timecode = t.timecode;
  const video = type === 'video';
  return {
    index,
    codec_type: type,
    codec_name: t.codec.name,
    codec_tag_string: t.tag ? tagString(t.tag) : null,
    profile: t.codec.profile,
    pix_fmt: video ? t.codec.pixFmt : null,
    width: video ? t.codec.width : null,
    height: video ? t.codec.height : null,
    time_base: t.timescale > 0 ? `1/${t.timescale}` : null,
    start_pts: t.timescale > 0 ? start : null,
    duration_ts: duration,
    r_frame_rate: r,
    avg_frame_rate: avg,
    bits_per_raw_sample: t.codec.bits,
    disposition: { attached_pic: 0 },
    tags,
  };
}

/** Container duration like ffprobe: latest stream end minus earliest stream start, in seconds. */
function formatDuration(tracks: Track[], movieTimescale: number, mvhdDuration: number | null): number | null {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const t of tracks) {
    if (!(t.timescale > 0)) continue;
    const { start, duration } = presentation(t, movieTimescale);
    if (duration === null) continue;
    const s = Math.round((start * 1e6) / t.timescale);
    const e = s + Math.round((duration * 1e6) / t.timescale);
    minStart = Math.min(minStart, s);
    maxEnd = Math.max(maxEnd, e);
  }
  if (Number.isFinite(minStart) && maxEnd > minStart) return (maxEnd - minStart) / 1e6;
  if (mvhdDuration && movieTimescale > 0) return Math.round((mvhdDuration * 1e6) / movieTimescale) / 1e6;
  return null;
}

// ---------------------------------------------------------------- top level

interface TopBox {
  type: string;
  start: number;
  hdr: number;
  size: number;
}

type Failure = Extract<IsoProbeResult, { ok: false }>;

function no(reason: Failure['reason'], detail: string): Failure {
  return { ok: false, reason, detail };
}

async function findMoov(read: ReadAt, fileSize: number): Promise<TopBox | Failure> {
  let off = 0;
  for (let n = 1; off + 8 <= fileSize; n++) {
    if (n > MAX_TOP_LEVEL_BOXES) return no('malformed', `more than ${MAX_TOP_LEVEL_BOXES} top-level boxes`);
    // 8 bytes, then 8 more only for a 64-bit size, so no payload byte is touched.
    const h = await read(off, 8);
    if (h.length < 8) return no('malformed', `short read at offset ${off}`);
    let size: number | null = u32(h, 0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (size === 1) {
      const large = off + 16 <= fileSize ? await read(off + 8, 8) : new Uint8Array(0);
      size = large.length >= 8 ? u64(large, 0) : null;
      hdr = 16;
    } else if (size === 0) {
      size = fileSize - off;
    }
    if (n === 1) {
      const known = type === 'ftyp' || QT_FIRST_BOXES.has(type);
      if (!known || size === null || size < hdr || (type === 'ftyp' && size > 4096)) {
        return no('not_iso', `file does not start with an MP4/MOV box (found '${tagString(type)}')`);
      }
    }
    if (!printableType(type)) return no('malformed', `unreadable box type at offset ${off}`);
    if (size === null || size < hdr) return no('malformed', `box '${type}' at offset ${off} has an invalid size`);
    if (type === 'moov') {
      if (off + size > fileSize) return no('malformed', `moov at offset ${off} runs past the end of the file`);
      if (size > ISO_MAX_MOOV_BYTES) return no('too_large', `moov is ${size} bytes (limit ${ISO_MAX_MOOV_BYTES})`);
      return { type, start: off, hdr, size };
    }
    if (off + size > fileSize) {
      return no('no_moov', `box '${type}' at offset ${off} runs past the end of the file before any moov (truncated?)`);
    }
    off += size;
  }
  return no('no_moov', 'no moov box at the top level (recording not finalized?)');
}

async function probe(read: ReadAt, fileSize: number): Promise<IsoProbeResult> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 8) return no('not_iso', `file is too small (${fileSize} bytes)`);
  const found = await findMoov(read, fileSize);
  if ('ok' in found) return found;
  const bodySize = found.size - found.hdr;
  const raw = await read(found.start + found.hdr, bodySize);
  if (raw.length < bodySize) return no('malformed', 'short read of moov');
  const b = raw.length > bodySize ? raw.subarray(0, bodySize) : raw;

  const moov = children(b, 0, b.length);
  if (kid(moov, 'cmov')) return no('malformed', 'compressed movie header (cmov) is not supported');
  const mvhdBox = kid(moov, 'mvhd');
  if (!mvhdBox) return no('malformed', 'moov has no mvhd');
  const mvhd = parseHeader(b, mvhdBox);

  const tracks: Track[] = [];
  const streams: Record<string, unknown>[] = [];
  let index = 0;
  const trackIndex: number[] = [];
  for (const box of moov) {
    if (box.type === 'trak') {
      tracks.push(parseTrak(b, box));
      trackIndex.push(index++);
    } else if (box.type === 'udta' || box.type === 'meta') {
      // Cover art becomes an attached-picture stream where ffprobe meets it.
      for (let i = countCoverArt(b, box); i > 0; i--) {
        streams.push({ index: index++, codec_type: 'video', time_base: '1/90000', disposition: { attached_pic: 1 } });
      }
    }
  }

  for (const t of tracks) {
    if (t.firstSample === null) continue;
    if (t.tmcd) {
      const sample = await read(t.firstSample, 4);
      t.timecode = tmcdTimecode(t.tmcd, sample);
    } else if (t.codec.proresDeep) {
      const header = await read(t.firstSample, 26);
      t.codec = { ...t.codec, pixFmt: proresPixFmt(true, header) };
    }
  }

  tracks.forEach((t, i) => streams.push(streamJson(t, trackIndex[i]!, mvhd.timescale)));
  streams.sort((x, y) => (x.index as number) - (y.index as number));

  const formatTags: Record<string, string> = {};
  const created = creationString(mvhd.creation);
  if (created) formatTags.creation_time = created;
  const json = {
    streams,
    format: {
      format_name: FORMAT_NAME,
      duration: formatDuration(tracks, mvhd.timescale, mvhd.duration),
      tags: formatTags,
    },
  };
  return { ok: true, probe: normalizeProbe(json) };
}

/**
 * Probe an MP4/MOV file through `read`. Resolves to the same ProbeNormalized
 * the server builds from ffprobe, or a reason it could not: not_iso (not an
 * ISO/QuickTime file), no_moov (unfinished or truncated recording), too_large
 * (moov over 256 MB) or malformed. Never throws, including when `read` fails.
 */
export async function probeIsoFile(read: ReadAt, fileSize: number): Promise<IsoProbeResult> {
  try {
    return await probe(read, fileSize);
  } catch (e) {
    const detail = e instanceof IsoError ? e.message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    return no('malformed', detail);
  }
}
