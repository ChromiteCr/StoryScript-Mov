import type {
  Availability,
  CoverageFlag,
  CoverageStatus,
  HashStatus,
  LinkEvidence,
  LinkStatus,
  MediaKind,
  MissingReason,
  RequiredStatus,
  TakeRating,
} from '@storyscript/contracts';

/**
 * Chinese display labels for the set log and the media library (FR-07…09).
 * Pure data. Wording rule (INV-08): a hashed clip is "已校验" — no label
 * here claims a safe second copy exists or that a camera card may be wiped.
 */

export const RATING_LABEL: Record<TakeRating, string> = {
  good: '好',
  alternate: '备选',
  reject: '废',
  unrated: '未评',
};

/** Digit keys on the set page; order is the button order. */
export const RATING_KEYS: readonly { key: string; rating: TakeRating }[] = [
  { key: '1', rating: 'good' },
  { key: '2', rating: 'alternate' },
  { key: '3', rating: 'reject' },
  { key: '0', rating: 'unrated' },
];

export function ratingForKey(key: string): TakeRating | null {
  return RATING_KEYS.find((k) => k.key === key)?.rating ?? null;
}

export const REQUIRED_LABEL: Record<RequiredStatus, string> = { required: '必拍', optional: '可选', waived: '免拍' };

export const COVERAGE_STATUS_LABEL: Record<CoverageStatus, string> = {
  planned: '未拍',
  attempted: '已拍待定',
  usable: '可用',
  needs_pickup: '需补拍',
  waived: '免拍',
};

export const COVERAGE_STATUS_HINT: Record<CoverageStatus, string> = {
  planned: '还没有场记',
  attempted: '有场记或已确认的素材，但还没有判定可用',
  usable: '已选定确认过、原片在线的片段',
  needs_pickup: '已决定补拍',
  waived: '已免拍，不计入漏拍',
};

export const MISSING_REASON_LABEL: Record<MissingReason, string> = {
  no_take: '无场记',
  no_link: '无关联素材',
  no_confirmed_usable: '无已确认的可用片段',
  file_offline: '原片离线',
};

export const MISSING_REASON_HINT: Record<MissingReason, string> = {
  no_take: '现场没有记录这个镜头的条次。',
  no_link: '有条次，但还没有素材关联到这个镜头。',
  no_confirmed_usable: '有关联素材，但没有确认并判定为可用的片段。',
  file_offline: '已确认的片段所在磁盘不在线。',
};

export const MISSING_ORDER: readonly MissingReason[] = ['no_take', 'no_link', 'no_confirmed_usable', 'file_offline'];

export const FLAG_LABEL: Record<CoverageFlag, string> = {
  previously_usable: '曾判为可用',
  source_offline: '原片离线',
  decision_stale: '镜头已修改，决定待复核',
};

export const EVIDENCE_LABEL: Record<LinkEvidence, string> = {
  R1: '文件名含打板编号',
  R2: '机内文件名与场记一致',
  R3: '自定义规则匹配',
  manual: '手动关联',
};

export const LINK_STATUS_LABEL: Record<LinkStatus, string> = { candidate: '候选', confirmed: '已确认', rejected: '已拒绝' };

export const HASH_STATUS_LABEL: Record<HashStatus, string> = {
  pending: '等待校验',
  done: '已校验',
  source_changed: '原片已变化',
  failed: '校验失败',
  skipped: '未校验',
};

export const AVAILABILITY_LABEL: Record<Availability, string> = { online: '在线', offline: '离线' };

export const KIND_LABEL: Record<MediaKind, string> = { video: '视频', audio: '音频', image: '图片', other: '其他' };

/** Shown on every clip that Chromium cannot play directly (FR-08). */
export const NEEDS_PROXY_LABEL = '需代理（v0.2）';

export const FFMPEG_INSTALL_COMMAND = 'brew install ffmpeg';

/** Candidate-rule error codes from core (plus the server's NO_SOURCE_RANGE). */
export const CANDIDATE_ERROR_LABEL: Record<string, string> = {
  INVALID_FORMAT: '项目的打板编号格式无法解析',
  INVALID_REGEX: '自定义规则无效',
  NO_SOURCE_RANGE: '素材没有可用的时间范围，未生成关联',
};
