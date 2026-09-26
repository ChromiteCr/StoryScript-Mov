import type { ErrorCode, ProbeNormalized, SourceRange, StreamInfo } from '@storyscript/contracts';

/**
 * source_range checks beyond the zod shape (SPEC §8.3, invariant SR):
 * five JSON integers, half-open [in_pts, out_pts), PTS inside the JS safe
 * integer range, and a stream/time base that match the probed asset exactly.
 */

export type SourceRangeProblem =
  | 'NOT_INTEGER'
  | 'UNSAFE_INTEGER'
  | 'EMPTY_RANGE'
  | 'INVALID_TIMEBASE'
  | 'NO_PROBE'
  | 'STREAM_NOT_FOUND'
  | 'UNSUPPORTED_TIMEBASE'
  | 'OUT_OF_BOUNDS';

export type SourceRangeCheck =
  | { ok: true }
  | {
      ok: false;
      problem: SourceRangeProblem;
      /** API error code to surface (contracts ErrorCode) */
      code: Extract<ErrorCode, 'VALIDATION_ERROR' | 'UNSUPPORTED_TIMEBASE'>;
      message: string;
    };

const fail = (problem: SourceRangeProblem, message: string): SourceRangeCheck => ({
  ok: false,
  problem,
  code: problem === 'UNSAFE_INTEGER' || problem === 'UNSUPPORTED_TIMEBASE' ? 'UNSUPPORTED_TIMEBASE' : 'VALIDATION_ERROR',
  message,
});

/** Shape-only check (no asset needed): integers, safe range, in < out, positive time base. */
export function checkSourceRangeShape(range: unknown): SourceRangeCheck {
  if (!range || typeof range !== 'object') return fail('NOT_INTEGER', 'source_range must be an object of five integers');
  const r = range as Record<string, unknown>;
  const fields = ['stream_index', 'in_pts', 'out_pts', 'time_base_num', 'time_base_den'] as const;
  for (const f of fields) {
    const v = r[f];
    if (typeof v !== 'number' || !Number.isInteger(v)) return fail('NOT_INTEGER', `${f} must be an integer`);
  }
  for (const f of fields) {
    if (!Number.isSafeInteger(r[f])) return fail('UNSAFE_INTEGER', `${f} is outside the safe integer range and cannot be represented exactly`);
  }
  const { stream_index, in_pts, out_pts, time_base_num, time_base_den } = r as unknown as SourceRange;
  if (stream_index < 0) return fail('STREAM_NOT_FOUND', 'stream_index must be ≥ 0');
  if (time_base_num <= 0 || time_base_den <= 0) return fail('INVALID_TIMEBASE', 'time base numerator and denominator must be positive');
  if (!(out_pts > in_pts)) return fail('EMPTY_RANGE', 'out_pts must be greater than in_pts');
  return { ok: true };
}

/**
 * Full check against the asset's probe: the stream must exist, its time base
 * must match exactly (no silent re-basing), and when the stream reports
 * start_pts/duration_ts the range must lie inside [start, start + duration].
 */
export function validateSourceRange(
  range: unknown,
  asset: { probe: Pick<ProbeNormalized, 'streams'> | null } | null,
): SourceRangeCheck {
  const shape = checkSourceRangeShape(range);
  if (!shape.ok) return shape;
  const r = range as SourceRange;
  if (!asset?.probe) return fail('NO_PROBE', 'the asset has no probe data to check the range against');
  const stream = asset.probe.streams.find((s) => s.index === r.stream_index);
  if (!stream) return fail('STREAM_NOT_FOUND', `stream ${r.stream_index} does not exist in the asset`);
  if (stream.time_base_num !== r.time_base_num || stream.time_base_den !== r.time_base_den) {
    return fail(
      'UNSUPPORTED_TIMEBASE',
      `time base ${r.time_base_num}/${r.time_base_den} differs from stream ${stream.index} (${stream.time_base_num}/${stream.time_base_den})`,
    );
  }
  if (stream.start_pts !== null && stream.duration_ts !== null) {
    const start = stream.start_pts;
    const end = start + stream.duration_ts;
    if (r.in_pts < start || r.out_pts > end) {
      return fail('OUT_OF_BOUNDS', `range [${r.in_pts}, ${r.out_pts}) exceeds stream ${stream.index} [${start}, ${end})`);
    }
  }
  return { ok: true };
}

/**
 * The exact whole-stream range [start_pts, start_pts + duration_ts) used when a
 * whole clip is linked (FR-09). Null when the probe lacks reliable bounds.
 */
export function wholeStreamRange(stream: Pick<StreamInfo, 'index' | 'time_base_num' | 'time_base_den' | 'start_pts' | 'duration_ts'>): SourceRange | null {
  if (stream.start_pts === null || stream.duration_ts === null || stream.duration_ts <= 0) return null;
  const out = stream.start_pts + stream.duration_ts;
  if (!Number.isSafeInteger(out)) return null;
  return {
    stream_index: stream.index,
    in_pts: stream.start_pts,
    out_pts: out,
    time_base_num: stream.time_base_num,
    time_base_den: stream.time_base_den,
  };
}
