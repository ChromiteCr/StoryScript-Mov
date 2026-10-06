/**
 * The 12 standard shots used for look review (`npm run look`), golden SVGs and
 * layout tests. All original, synthetic data — no film, director or character
 * references (docs/CLEANROOM.md).
 */
import type { BoardSpec, LookPreset, ScreenSides, ShotFields, ShotSubject } from '@storyscript/contracts';
import { layoutBoard, type RosterEntry } from '../layout.ts';

/** Fixture copy of the built-in look preset "宽银幕铅笔分镜". */
export const STANDARD_LOOK: LookPreset = {
  id: 'look-widescreen-pencil',
  version: 1,
  name: '宽银幕铅笔分镜',
  default_aspect: '2.39',
  center_guide: true,
  set_piece_low_wide: true,
  pencil: { hatch_angle_deg: 38, paper_tone: '#F3F0E8', outline_px: { fg: 2.2, mg: 1.4, bg: 0.9 } },
};

export const STANDARD_ROSTER: RosterEntry[] = [
  { alias: 'c1', label: '甲', badge: 'A', entity_id: null, height_m: 1.76, silhouette: 'regular' },
  { alias: 'c2', label: '乙', badge: 'B', entity_id: null, height_m: 1.64, silhouette: 'dress' },
  { alias: 'c3', label: '丙', badge: 'C', entity_id: null, height_m: 1.82, silhouette: 'coat' },
  { alias: 'c4', label: '丁', badge: 'D', entity_id: null, height_m: 1.6, silhouette: 'regular' },
];

export const STANDARD_SIDES: ScreenSides = { left: 'c1', right: 'c2' };

export function shotFields(p: Partial<ShotFields>): ShotFields {
  return {
    template: null,
    shot_size: 'MS',
    angle: 'eye',
    lens: 'normal',
    focal_mm: null,
    movement: 'static',
    subjects: [],
    props: [],
    env: null,
    subject_motion: 'none',
    set_piece: false,
    pov_owner: null,
    frame_format: null,
    technique_id: null,
    est_seconds: 3,
    narrative_purpose: '',
    action: '',
    dialogue_quote: null,
    source: { paragraph_id: 'p-001', quote: '' },
    assumptions: [],
    questions: [],
    ...p,
  };
}

export function subject(alias: string, o: Partial<Omit<ShotSubject, 'alias'>> = {}): ShotSubject {
  return { alias, screen: null, depth: null, facing: null, pose: null, ...o };
}

export interface StandardShot {
  key: string;
  name: string;
  fields: ShotFields;
  roster: RosterEntry[];
  scene_sides: ScreenSides | null;
}

export const STANDARD_SHOTS: StandardShot[] = [
  {
    key: '01-ews-scale',
    name: 'EWS 尺度',
    fields: shotFields({
      shot_size: 'EWS',
      angle: 'low',
      lens: 'wide',
      set_piece: true,
      env: 'open',
      props: ['building'],
      subjects: [subject('c1', { facing: 'away' })],
      narrative_purpose: '人物在巨大体块前显得渺小',
      action: '甲停在空地中央，抬头看面前的巨墙',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '02-low-hero',
    name: '低机位英雄',
    fields: shotFields({
      shot_size: 'MLS',
      angle: 'low',
      lens: 'wide',
      env: 'street',
      subjects: [subject('c3', { facing: '3q_left' })],
      narrative_purpose: '确立人物的压迫感',
      action: '丙站在街口，俯视镜头',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '03-ots-a',
    name: '正反打 过肩 A',
    fields: shotFields({
      shot_size: 'MS',
      lens: 'normal',
      env: 'interior',
      props: ['window'],
      pov_owner: 'c1',
      subjects: [subject('c1'), subject('c2')],
      narrative_purpose: '对话：从甲的视点看乙',
      action: '乙回答甲的问题',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: STANDARD_SIDES,
  },
  {
    key: '04-ots-b',
    name: '过肩 B（反打）',
    fields: shotFields({
      shot_size: 'MS',
      lens: 'normal',
      env: 'interior',
      props: ['door'],
      pov_owner: 'c2',
      subjects: [subject('c1'), subject('c2')],
      narrative_purpose: '对话反打：从乙的视点看甲',
      action: '甲沉默片刻',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: STANDARD_SIDES,
  },
  {
    key: '05-mcu',
    name: 'MCU 单人',
    fields: shotFields({
      shot_size: 'MCU',
      lens: 'normal',
      env: 'interior',
      props: ['door'],
      subjects: [subject('c2', { facing: '3q_right', screen: 'L' })],
      narrative_purpose: '人物反应',
      action: '乙转头看向画右',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '06-ecu',
    name: 'ECU 面孔',
    fields: shotFields({
      shot_size: 'ECU',
      lens: 'tele',
      env: 'interior',
      subjects: [subject('c1', { facing: 'camera' })],
      narrative_purpose: '大画幅里的面孔特写',
      action: '甲直视前方',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '07-chase',
    name: '横移追逐',
    fields: shotFields({
      shot_size: 'FS',
      lens: 'normal',
      movement: 'track',
      env: 'street',
      subject_motion: 'l2r',
      subjects: [subject('c1', { pose: 'run' }), subject('c3', { pose: 'run' })],
      narrative_purpose: '追逐的速度与方向',
      action: '甲从画左跑向画右，丙紧追',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '08-vehicle',
    name: '载具硬挂',
    fields: shotFields({
      shot_size: 'MS',
      lens: 'wide',
      movement: 'vehicle',
      env: 'street',
      props: ['car'],
      subject_motion: 'toward',
      subjects: [subject('c2', { pose: 'run', facing: 'camera', screen: 'R' })],
      narrative_purpose: '车身挂机，人物追车',
      action: '乙沿车身追向镜头',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '09-overhead',
    name: '俯拍（顶拍）',
    fields: shotFields({
      shot_size: 'FS',
      angle: 'overhead',
      lens: 'normal',
      env: 'interior',
      props: ['table', 'chair'],
      subjects: [subject('c4', { facing: 'screen_right' })],
      narrative_purpose: '上帝视角交代站位',
      action: '丁站在桌边',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '10-depth-two',
    name: '双人纵深（前后景）',
    fields: shotFields({
      shot_size: 'MS',
      lens: 'wide',
      env: 'interior',
      props: ['door'],
      subjects: [
        subject('c1', { depth: 'fg', screen: 'L', facing: '3q_right' }),
        subject('c2', { depth: 'bg', screen: 'R', facing: 'camera' }),
      ],
      narrative_purpose: '前后景的关系',
      action: '甲在前景侧身，乙在门口',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: STANDARD_SIDES,
  },
  {
    key: '11-insert',
    name: '插入特写（桌上盒子）',
    fields: shotFields({
      shot_size: 'INSERT',
      lens: 'normal',
      env: 'interior',
      props: ['box', 'table'],
      narrative_purpose: '关键道具',
      action: '桌上的盒子',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: '12-group',
    name: '群戏（4 人）',
    fields: shotFields({
      shot_size: 'WS',
      angle: 'high',
      lens: 'normal',
      env: 'interior',
      props: ['table'],
      subjects: [
        subject('c1', { pose: 'point' }),
        subject('c2', { pose: 'sit' }),
        subject('c3', { pose: 'stand' }),
        subject('c4', { pose: 'crouch' }),
      ],
      narrative_purpose: '交代四人的站位关系',
      action: '甲指向远处，乙坐着，丙站着，丁蹲在地上',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: STANDARD_SIDES,
  },
];

/**
 * S4c variety sheet: the new places, props and poses (look review and layout
 * tests; the look metrics stay on the 12 standard shots above).
 */
export const VARIETY_SHOTS: StandardShot[] = [
  {
    key: 'v01-classroom-two',
    name: '教室 双人',
    fields: shotFields({
      shot_size: 'MS',
      template: 'two_shot',
      env: 'classroom',
      subjects: [subject('c1', { pose: 'stand' }), subject('c2', { pose: 'stand' })],
      narrative_purpose: '下课后两人在教室里说话',
      action: '甲和乙隔着课桌说话',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: STANDARD_SIDES,
  },
  {
    key: 'v02-corridor-walk',
    name: '走廊 迎面走来',
    fields: shotFields({
      shot_size: 'WS',
      lens: 'wide',
      movement: 'pull_out',
      env: 'corridor',
      subject_motion: 'toward',
      subjects: [subject('c3', { pose: 'walk', facing: 'camera' })],
      narrative_purpose: '丙从走廊尽头走来',
      action: '丙沿着走廊走向镜头',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v03-nature-kneel',
    name: '野外 跪地',
    fields: shotFields({
      shot_size: 'FS',
      angle: 'high',
      env: 'nature',
      subjects: [subject('c4', { pose: 'kneel', facing: '3q_right' })],
      narrative_purpose: '丁在林边跪下',
      action: '丁跪在草地上',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v04-bedroom-lie',
    name: '卧室 躺',
    fields: shotFields({
      shot_size: 'MS',
      angle: 'high',
      env: 'interior',
      props: ['bed', 'lamp'],
      subjects: [subject('c2', { pose: 'lie', facing: 'screen_left' })],
      narrative_purpose: '乙躺在床上睡不着',
      action: '乙躺着看天花板',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v05-sofa-sit',
    name: '客厅 沙发',
    fields: shotFields({
      shot_size: 'MLS',
      env: 'interior',
      props: ['sofa'],
      subjects: [subject('c1', { pose: 'sit', facing: 'camera' })],
      narrative_purpose: '甲坐在沙发上等人',
      action: '甲坐着',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v06-insert-phone',
    name: '插入 手机',
    fields: shotFields({
      shot_size: 'INSERT',
      angle: 'high',
      props: ['phone'],
      env: 'interior',
      narrative_purpose: '桌上的手机亮了',
      action: '手机在桌上震动',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v07-insert-cup',
    name: '插入 杯子',
    fields: shotFields({
      shot_size: 'INSERT',
      props: ['table', 'cup'],
      env: 'interior',
      narrative_purpose: '桌上那杯没动过的水',
      action: '杯子放在桌上',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v08-street-away',
    name: '街道 背影',
    fields: shotFields({
      shot_size: 'WS',
      env: 'street',
      subject_motion: 'away',
      subjects: [subject('c1', { pose: 'walk', facing: 'away', screen: 'L' }), subject('c2', { pose: 'walk', facing: 'away', screen: 'L' })],
      narrative_purpose: '两人沿街走远',
      action: '甲和乙并肩走远',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v09-mcu-shelf',
    name: '近景 书架前（三分线）',
    fields: shotFields({
      shot_size: 'MCU',
      env: 'interior',
      props: ['shelf'],
      subjects: [subject('c1', { facing: '3q_right' })],
      narrative_purpose: '甲看向对面的人',
      action: '甲听着，没说话',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: STANDARD_SIDES,
  },
  {
    key: 'v10-reach-shelf',
    name: '伸手 拿书',
    fields: shotFields({
      shot_size: 'MS',
      env: 'interior',
      props: ['shelf', 'book'],
      subjects: [subject('c2', { pose: 'reach', facing: 'screen_right' })],
      narrative_purpose: '乙去拿书架上的书',
      action: '乙伸手够书',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v11-phone-call',
    name: '打电话',
    fields: shotFields({
      shot_size: 'MCU',
      angle: 'low',
      env: 'interior',
      subjects: [subject('c4', { pose: 'phone', facing: '3q_left' })],
      narrative_purpose: '丁接到电话',
      action: '丁拿着手机听',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: null,
  },
  {
    key: 'v12-reverse-single',
    name: '正反打 单人（乙）',
    fields: shotFields({
      shot_size: 'MCU',
      env: 'interior',
      subjects: [subject('c2')],
      narrative_purpose: '乙回答',
      action: '乙看着甲说话',
    }),
    roster: STANDARD_ROSTER,
    scene_sides: STANDARD_SIDES,
  },
];

/** Lay out a standard shot with the fixture look (2.39 frame). */
export function standardBoard(shot: StandardShot, seed = 7): BoardSpec {
  return layoutBoard(shot.fields, {
    scene_sides: shot.scene_sides,
    roster: shot.roster,
    look: STANDARD_LOOK,
    technique: null,
    aspect: '2.39',
    seed,
  });
}
