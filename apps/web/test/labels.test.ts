import { describe, expect, it } from 'vitest';
import {
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
  SettingSource,
  ShotFields,
  ShotSize,
  SubjectMotion,
} from '@storyscript/contracts';
import * as L from '../src/lib/labels.ts';

// Every contract enum value has a non-empty Chinese label (display-only).

const TABLES: [string, { options: readonly string[] }, Record<string, string>][] = [
  ['ShotSize', ShotSize, L.SHOT_SIZE_LABEL],
  ['CameraAngle', CameraAngle, L.ANGLE_LABEL],
  ['LensClass', LensClass, L.LENS_LABEL],
  ['Movement', Movement, L.MOVEMENT_LABEL],
  ['ScreenPos', ScreenPos, L.SCREEN_POS_LABEL],
  ['DepthPlane', DepthPlane, L.DEPTH_LABEL],
  ['Facing', Facing, L.FACING_LABEL],
  ['Pose', Pose, L.POSE_LABEL],
  ['PropKind', PropKind, L.PROP_LABEL],
  ['EnvKind', EnvKind, L.ENV_LABEL],
  ['SubjectMotion', SubjectMotion, L.SUBJECT_MOTION_LABEL],
  ['BoardTemplate', BoardTemplate, L.TEMPLATE_LABEL],
  ['FrameFormat', FrameFormat, L.FRAME_FORMAT_LABEL],
  ['RequiredStatus', RequiredStatus, L.REQUIRED_STATUS_LABEL],
  ['QuoteMatch', QuoteMatch, L.QUOTE_MATCH_LABEL],
  ['Origin', Origin, L.ORIGIN_LABEL],
  ['EntityType', EntityType, L.ENTITY_TYPE_LABEL],
  ['JobStatus', JobStatus, L.JOB_STATUS_LABEL],
  ['JobKind', JobKind, L.JOB_KIND_LABEL],
  ['DraftStatus', DraftStatus, L.DRAFT_STATUS_LABEL],
  ['ScriptFormat', ScriptFormat, L.SCRIPT_FORMAT_LABEL],
  ['SettingSource', SettingSource, L.SETTING_SOURCE_LABEL],
];

describe('Chinese label tables cover every contract enum value', () => {
  for (const [name, schema, labels] of TABLES) {
    it(name, () => {
      expect(Object.keys(labels).sort()).toEqual([...schema.options].sort());
      for (const v of schema.options) expect(labels[v]?.trim(), `${name}.${v}`).toBeTruthy();
    });
  }

  it('ShotFields keys all have a field label', () => {
    expect(Object.keys(L.SHOT_FIELD_LABEL).sort()).toEqual(Object.keys(ShotFields.shape).sort());
  });

  it('uses the agreed wording for shot sizes and angles', () => {
    expect(L.SHOT_SIZE_LABEL).toMatchObject({ EWS: '大远景', WS: '远景', FS: '全景', MLS: '中全景', MS: '中景', MCU: '中近景', CU: '近景', ECU: '特写', INSERT: '插入' });
    expect(L.ANGLE_LABEL).toEqual({ eye: '平视', low: '仰拍', high: '俯拍', overhead: '顶拍', dutch: '斜角' });
    expect(L.MOVEMENT_LABEL).toMatchObject({ push_in: '推', pull_out: '拉', pan: '摇', tilt: '俯仰', track: '移', crane: '升降', handheld: '手持', vehicle: '车载', static: '固定' });
  });

  it('labels contain no English enum leftovers', () => {
    for (const [name, , labels] of TABLES) {
      if (name === 'ScriptFormat' || name === 'FrameFormat' || name === 'Origin') continue;
      for (const v of Object.values(labels)) expect(v, `${name}: ${v}`).not.toMatch(/[a-z]{3,}/);
    }
  });

  it('shotSpecLine prefers the focal length over the lens class', () => {
    expect(L.shotSpecLine({ shot_size: 'MCU', angle: 'low', lens: 'tele', focal_mm: 85, movement: 'push_in' })).toBe('中近景 · 仰拍 · 85mm · 推');
    expect(L.shotSpecLine({ shot_size: 'WS', angle: 'eye', lens: 'wide', focal_mm: null, movement: 'static' })).toBe('远景 · 平视 · 广角 · 固定');
  });
});
