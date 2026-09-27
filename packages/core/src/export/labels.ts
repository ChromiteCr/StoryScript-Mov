import type {
  Availability,
  BlockKind,
  CoverageFlag,
  CoverageStatus,
  LinkEvidence,
  LinkStatus,
  MissingReason,
  Origin,
  QuoteMatch,
  RequiredStatus,
  TakeRating,
} from '@storyscript/contracts';

/**
 * Chinese cell values of the CSV exports (FR-10). The page and the server
 * write CSV through the same builders (tables.ts), so these tables are the
 * one source of the exported wording. They mirror the display labels of the
 * web (apps/web/src/lib/labels-media.ts, labels-plan.ts); a web test keeps
 * the two in step.
 */

export const CSV_RATING_LABEL: Record<TakeRating, string> = {
  good: '好',
  alternate: '备选',
  reject: '废',
  unrated: '未评',
};

export const CSV_REQUIRED_LABEL: Record<RequiredStatus, string> = { required: '必拍', optional: '可选', waived: '免拍' };

export const CSV_COVERAGE_STATUS_LABEL: Record<CoverageStatus, string> = {
  planned: '未拍',
  attempted: '已拍待定',
  usable: '可用',
  needs_pickup: '需补拍',
  waived: '免拍',
};

export const CSV_MISSING_REASON_LABEL: Record<MissingReason, string> = {
  no_take: '无场记',
  no_link: '无关联素材',
  no_confirmed_usable: '无已确认的可用片段',
  file_offline: '原片离线',
};

export const CSV_FLAG_LABEL: Record<CoverageFlag, string> = {
  previously_usable: '曾判为可用',
  source_offline: '原片离线',
  decision_stale: '镜头已修改，决定待复核',
};

export const CSV_EVIDENCE_LABEL: Record<LinkEvidence, string> = {
  R1: '文件名含打板编号',
  R2: '机内文件名与场记一致',
  R3: '自定义规则匹配',
  manual: '手动关联',
};

export const CSV_LINK_STATUS_LABEL: Record<LinkStatus, string> = { candidate: '候选', confirmed: '已确认', rejected: '已拒绝' };

export const CSV_AVAILABILITY_LABEL: Record<Availability, string> = { online: '在线', offline: '离线' };

export const CSV_BLOCK_KIND_LABEL: Record<BlockKind, string> = {
  setup: '准备',
  shoot: '拍摄',
  reset: '复位',
  buffer: '锁定余量',
};

export const CSV_ORIGIN_LABEL: Record<Origin, string> = { ai: 'AI 草案', manual: '手工' };

export const CSV_QUOTE_MATCH_LABEL: Record<QuoteMatch, string> = { exact: '原文一致', fuzzy: '近似', manual: '手工指定' };
