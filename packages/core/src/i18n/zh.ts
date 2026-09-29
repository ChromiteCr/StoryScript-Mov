/**
 * Chinese display labels for the closed vocabularies in contracts/shot.ts.
 * Display-only: storage and LLM I/O always use the English enum values.
 */
import type {
  BoardTemplate,
  CameraAngle,
  DepthPlane,
  EnvKind,
  Facing,
  FrameFormat,
  LensClass,
  Movement,
  Pose,
  PropKind,
  ScreenPos,
  ShotSize,
  SubjectMotion,
} from '@storyscript/contracts';

export const ZH_SHOT_SIZE: Record<ShotSize, string> = {
  EWS: '大远景',
  WS: '远景',
  FS: '全景',
  MLS: '中全景',
  MS: '中景',
  MCU: '近景',
  CU: '特写',
  ECU: '大特写',
  INSERT: '插入镜头',
};

export const ZH_CAMERA_ANGLE: Record<CameraAngle, string> = {
  eye: '平视',
  low: '仰拍',
  high: '俯拍',
  overhead: '顶拍',
  dutch: '斜角',
};

export const ZH_LENS_CLASS: Record<LensClass, string> = {
  wide: '广角',
  normal: '标准',
  tele: '长焦',
};

export const ZH_MOVEMENT: Record<Movement, string> = {
  static: '固定',
  push_in: '推',
  pull_out: '拉',
  pan: '摇',
  tilt: '俯仰',
  track: '移',
  crane: '升降',
  handheld: '手持',
  vehicle: '车载',
  orbit: '环绕',
  aerial: '航拍',
  dolly_zoom: '变焦推拉',
};

export const ZH_SCREEN_POS: Record<ScreenPos, string> = { L: '画左', C: '画中', R: '画右' };

export const ZH_DEPTH_PLANE: Record<DepthPlane, string> = { fg: '前景', mg: '中景层', bg: '背景' };

export const ZH_FACING: Record<Facing, string> = {
  camera: '面向镜头',
  away: '背向镜头',
  screen_left: '朝画左',
  screen_right: '朝画右',
  '3q_left': '3/4 朝画左',
  '3q_right': '3/4 朝画右',
};

export const ZH_POSE: Record<Pose, string> = {
  stand: '站',
  walk: '走',
  run: '跑',
  sit: '坐',
  point: '指',
  crouch: '蹲',
};

export const ZH_PROP_KIND: Record<PropKind, string> = {
  door: '门',
  table: '桌',
  chair: '椅',
  car: '车',
  wall: '墙',
  building: '楼',
  stairs: '楼梯',
  window: '窗',
  box: '箱',
};

export const ZH_ENV_KIND: Record<EnvKind, string> = { open: '开阔地', interior: '室内', street: '街道' };

export const ZH_SUBJECT_MOTION: Record<SubjectMotion, string> = {
  none: '无',
  l2r: '左→右',
  r2l: '右→左',
  toward: '向镜头',
  away: '离开镜头',
};

export const ZH_BOARD_TEMPLATE: Record<BoardTemplate, string> = {
  establishing: '交代镜头',
  single: '单人',
  two_shot: '双人',
  ots: '过肩',
  insert: '插入特写',
  lateral_move: '横向运动',
  scale: '尺度对比',
};

export const ZH_FRAME_FORMAT: Record<FrameFormat, string> = {
  '2.39': '2.39:1 宽银幕',
  '2.20': '2.20:1',
  '1.90': '1.90:1',
  '1.78': '16:9',
  '1.43': '1.43:1',
};

/** Fixed board UI / render strings. */
export const ZH_BOARD = {
  topviewNote: '站位示意（非实景测量）',
  camera: '摄影机',
  cameraAbove: '（正上方）',
  track: 'TRACK',
  dollyZoom: '变焦推拉',
  lint: {
    subject_count: (board: number, shot: number) => `分镜人数（${board}）与镜头人物数（${shot}）不一致`,
    ots_fg_not_cropped: (label: string) => `过肩前景人物「${label}」没有被画框裁切`,
    ots_fg_missing: '过肩镜头缺少前景人物',
    axis_cross: (left: string, right: string) => `越轴：「${left}」应在「${right}」的画左`,
    badge_duplicate: (badge: string) => `徽标「${badge}」重复`,
    badge_empty: (label: string) => `人物「${label}」没有徽标`,
    subject_offscreen: (label: string) => `人物「${label}」在画框外`,
    needs_manual_layout: (why: string) => `复杂镜头，需人工布局：${why}`,
    why_many_subjects: (n: number) => `${n} 人同框`,
    why_ots_count: (n: number) => `过肩镜头有 ${n} 人`,
    why_insert_subjects: '插入特写里有人物（仅支持道具）',
    why_motion_crowd: (n: number) => `${n} 人同时运动`,
  },
} as const;

/** "中景 · 40mm" style board label. */
export function shotLabelZh(size: ShotSize, focal_mm: number): string {
  return `${ZH_SHOT_SIZE[size]} · ${Math.round(focal_mm)}mm`;
}
