import type {
  BoardTemplate,
  CameraAngle,
  DepthPlane,
  DraftStatus,
  EntityType,
  EnvKind,
  Facing,
  FrameFormat,
  JobKind,
  JobStatus,
  LensClass,
  Movement,
  Origin,
  Pose,
  PropKind,
  QuoteMatch,
  RequiredStatus,
  ScreenPos,
  ScriptFormat,
  ShotFields,
  ShotSize,
  SubjectMotion,
} from '@storyscript/contracts';

/**
 * Chinese display labels for the closed vocabularies in contracts/shot.ts and
 * friends. Display-only: stored values stay English (contracts are the source
 * of truth). `test/labels.test.ts` asserts every enum option has a label.
 */

export const SHOT_SIZE_LABEL: Record<ShotSize, string> = {
  EWS: '大远景',
  WS: '远景',
  FS: '全景',
  MLS: '中全景',
  MS: '中景',
  MCU: '中近景',
  CU: '近景',
  ECU: '特写',
  INSERT: '插入',
};

export const ANGLE_LABEL: Record<CameraAngle, string> = {
  eye: '平视',
  low: '仰拍',
  high: '俯拍',
  overhead: '顶拍',
  dutch: '斜角',
};

export const LENS_LABEL: Record<LensClass, string> = {
  wide: '广角',
  normal: '标准',
  tele: '长焦',
};

export const MOVEMENT_LABEL: Record<Movement, string> = {
  static: '固定',
  push_in: '推',
  pull_out: '拉',
  pan: '摇',
  tilt: '俯仰',
  track: '移',
  crane: '升降',
  handheld: '手持',
  vehicle: '车载',
};

export const SCREEN_POS_LABEL: Record<ScreenPos, string> = {
  L: '画左',
  C: '画中',
  R: '画右',
};

export const DEPTH_LABEL: Record<DepthPlane, string> = {
  fg: '前景',
  mg: '中层',
  bg: '后景',
};

export const FACING_LABEL: Record<Facing, string> = {
  camera: '面向镜头',
  away: '背对镜头',
  screen_left: '朝画左',
  screen_right: '朝画右',
  '3q_left': '四分之三朝左',
  '3q_right': '四分之三朝右',
};

export const POSE_LABEL: Record<Pose, string> = {
  stand: '站',
  walk: '走',
  run: '跑',
  sit: '坐',
  point: '指向',
  crouch: '蹲',
};

export const PROP_LABEL: Record<PropKind, string> = {
  door: '门',
  table: '桌子',
  chair: '椅子',
  car: '汽车',
  wall: '墙',
  building: '建筑',
  stairs: '楼梯',
  window: '窗',
  box: '箱子',
};

export const ENV_LABEL: Record<EnvKind, string> = {
  open: '开阔外景',
  interior: '室内',
  street: '街道',
};

export const SUBJECT_MOTION_LABEL: Record<SubjectMotion, string> = {
  none: '无',
  l2r: '左→右',
  r2l: '右→左',
  toward: '走向镜头',
  away: '远离镜头',
};

export const TEMPLATE_LABEL: Record<BoardTemplate, string> = {
  establishing: '交代全景',
  single: '单人',
  two_shot: '双人',
  ots: '过肩',
  insert: '插入',
  lateral_move: '横向运动',
  scale: '尺度对比',
};

export const FRAME_FORMAT_LABEL: Record<FrameFormat, string> = {
  '2.39': '2.39 : 1（宽银幕）',
  '2.20': '2.20 : 1',
  '1.90': '1.90 : 1',
  '1.78': '1.78 : 1（16:9）',
  '1.43': '1.43 : 1',
};

export const REQUIRED_STATUS_LABEL: Record<RequiredStatus, string> = {
  required: '必拍',
  optional: '可选',
  waived: '取消拍摄',
};

export const QUOTE_MATCH_LABEL: Record<QuoteMatch, string> = {
  exact: '原文一致',
  fuzzy: '近似匹配',
  manual: '手工',
};

export const ORIGIN_LABEL: Record<Origin, string> = {
  ai: 'AI',
  manual: '手工',
};

export const ENTITY_TYPE_LABEL: Record<EntityType, string> = {
  character: '角色',
  location: '地点',
  prop: '道具',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  outcome_unknown: '结果未知',
};

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  extract_entities: '实体抽取',
  breakdown_scene: '拆镜',
  suggest_order: '排序建议',
  scan_root: '扫描素材目录',
  probe_asset: '读取素材信息',
  hash_asset: '计算校验值',
  poster_asset: '生成海报帧',
  image_redraw: '铅笔重绘',
};

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  pending: '待处理',
  applied: '已应用',
  discarded: '已放弃',
  failed: '失败',
};

export const SCRIPT_FORMAT_LABEL: Record<ScriptFormat, string> = {
  paste: '粘贴',
  txt: '纯文本',
  md: 'Markdown',
  fountain: 'Fountain',
};

export const SETTING_SOURCE_LABEL: Record<'env' | 'file', string> = {
  env: '环境变量',
  file: '本机配置文件',
};

/** Field names of ShotFields, for revision diffs and form labels. */
export const SHOT_FIELD_LABEL: Record<keyof ShotFields, string> = {
  template: '构图模板',
  shot_size: '景别',
  angle: '角度',
  lens: '镜头',
  focal_mm: '焦段',
  movement: '运动',
  subjects: '人物',
  props: '道具',
  env: '环境',
  subject_motion: '主体运动',
  set_piece: '重点段落',
  pov_owner: '视点人物',
  frame_format: '画幅',
  technique_id: '手法',
  est_seconds: '预计时长',
  narrative_purpose: '叙事作用',
  action: '动作',
  dialogue_quote: '台词',
  source: '引用原文',
  assumptions: '假设',
  questions: '待确认问题',
};

/** "中景 · 平视 · 50mm · 推" (lens class when no focal length). */
export function shotSpecLine(f: Pick<ShotFields, 'shot_size' | 'angle' | 'lens' | 'focal_mm' | 'movement'>): string {
  const lens = f.focal_mm !== null && Number.isFinite(f.focal_mm) ? `${Math.round(f.focal_mm)}mm` : LENS_LABEL[f.lens];
  return [SHOT_SIZE_LABEL[f.shot_size], ANGLE_LABEL[f.angle], lens, MOVEMENT_LABEL[f.movement]].join(' · ');
}
