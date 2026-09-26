import type { CoverageDecision, CoverageDecisionKind, ShotMediaLink, SourceRange, StreamInfo, Take, TakeRating } from '@storyscript/contracts';
import type { CoverageAsset, CoverageShot } from '../../src/coverage/compute.ts';

export const uid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const HASH = 'h-current';
export const RANGE: SourceRange = { stream_index: 0, in_pts: 0, out_pts: 90000, time_base_num: 1, time_base_den: 90000 };

export const shotOf = (id: string, required_status: CoverageShot['required_status'] = 'required'): CoverageShot => ({
  id,
  required_status,
  content_hash: HASH,
});

export function take(id: string, shotIds: string[], rating: TakeRating = 'unrated', takeNo = 1): Take {
  return {
    id,
    setup_id: null,
    take_no: takeNo,
    camera_label: 'A',
    rating,
    clip_hint: null,
    notes: '',
    unresolved_labels: [],
    logged_at: '2026-10-05T10:00:00.000Z',
    shot_ids: shotIds,
    revision: 0,
  };
}

export function link(
  id: string,
  shotId: string,
  assetId: string,
  status: ShotMediaLink['status'] = 'confirmed',
  range: SourceRange = RANGE,
): ShotMediaLink {
  return {
    id,
    shot_id: shotId,
    media_asset_id: assetId,
    take_id: null,
    source_range: range,
    evidence: 'manual',
    status,
    confirmed_at: status === 'confirmed' ? '2026-10-05T11:00:00.000Z' : null,
    revision: 0,
    created_at: '2026-10-05T10:30:00.000Z',
  };
}

export const video: StreamInfo = {
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
};

export const asset = (id: string, availability: CoverageAsset['availability'] = 'online', withProbe = false): CoverageAsset => ({
  id,
  availability,
  ...(withProbe ? { probe: { streams: [video] } } : {}),
});

let seq = 0;
export function decision(
  shotId: string,
  kind: CoverageDecisionKind,
  at: string,
  selected: string[] = [],
  basis = HASH,
  reason = 'director call',
): CoverageDecision {
  return {
    id: uid(0xd000 + seq++),
    shot_id: shotId,
    decision: kind,
    selected_link_ids: selected,
    reason,
    basis_content_hash: basis,
    at,
  };
}

export const T = (hh: number): string => `2026-10-05T${String(hh).padStart(2, '0')}:00:00.000Z`;
