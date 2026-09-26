import {
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
import { describe, expect, test } from 'vitest';
import {
  shotLabelZh,
  ZH_BOARD_TEMPLATE,
  ZH_CAMERA_ANGLE,
  ZH_DEPTH_PLANE,
  ZH_ENV_KIND,
  ZH_FACING,
  ZH_FRAME_FORMAT,
  ZH_LENS_CLASS,
  ZH_MOVEMENT,
  ZH_POSE,
  ZH_PROP_KIND,
  ZH_SCREEN_POS,
  ZH_SHOT_SIZE,
  ZH_SUBJECT_MOTION,
} from '../../src/index.ts';

describe('zh labels cover every closed vocabulary', () => {
  test.each([
    ['ShotSize', ShotSize.options, ZH_SHOT_SIZE],
    ['CameraAngle', CameraAngle.options, ZH_CAMERA_ANGLE],
    ['LensClass', LensClass.options, ZH_LENS_CLASS],
    ['Movement', Movement.options, ZH_MOVEMENT],
    ['ScreenPos', ScreenPos.options, ZH_SCREEN_POS],
    ['DepthPlane', DepthPlane.options, ZH_DEPTH_PLANE],
    ['Facing', Facing.options, ZH_FACING],
    ['Pose', Pose.options, ZH_POSE],
    ['PropKind', PropKind.options, ZH_PROP_KIND],
    ['EnvKind', EnvKind.options, ZH_ENV_KIND],
    ['SubjectMotion', SubjectMotion.options, ZH_SUBJECT_MOTION],
    ['BoardTemplate', BoardTemplate.options, ZH_BOARD_TEMPLATE],
    ['FrameFormat', FrameFormat.options, ZH_FRAME_FORMAT],
  ] as const)('%s', (_n, options, labels) => {
    const map = labels as Record<string, string>;
    expect(Object.keys(map).sort()).toEqual([...options].sort());
    for (const k of options) expect(map[k]?.length ?? 0).toBeGreaterThan(0);
  });

  test('board label', () => {
    expect(shotLabelZh('MS', 40.4)).toBe('中景 · 40mm');
  });
});
