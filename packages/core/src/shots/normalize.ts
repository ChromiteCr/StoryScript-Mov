/**
 * Lenient pre-normalisation of model output before zod (SPEC FR-03 step 2).
 * Only mechanical fixes: enum case and a small synonym table, missing nullable
 * fields → null, missing arrays → [], numeric strings → numbers. It never
 * guesses content: unknown values are left as they are so zod reports them and
 * the repair round can fix them.
 */

type Json = unknown;
type Rec = Record<string, Json>;

const isRec = (v: Json): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** lower-case, trim, unify separators: "Close-Up" → "close_up" */
function key(v: string): string {
  return v
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/'/g, '');
}

function table(entries: Record<string, readonly string[]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [canon, syns] of Object.entries(entries)) {
    m.set(key(canon), canon);
    for (const s of syns) m.set(key(s), canon);
  }
  return m;
}

const SHOT_SIZE = table({
  EWS: ['extreme wide', 'extreme wide shot', 'extreme long shot', 'xws', 'els', '大远景'],
  WS: ['wide', 'wide shot', 'long shot', 'ls', '远景'],
  FS: ['full', 'full shot', '全景'],
  MLS: ['medium long shot', 'medium long', 'medium wide', 'medium wide shot', 'mws', 'cowboy', '中全景'],
  MS: ['medium', 'medium shot', 'mid', 'mid shot', '中景'],
  MCU: ['medium close up', 'medium close_up', 'medium closeup', '近景', '中近景'],
  CU: ['close up', 'closeup', 'close', '特写'],
  ECU: ['extreme close up', 'extreme closeup', 'xcu', '大特写'],
  INSERT: ['insert shot', 'cutaway insert', '插入', '插入镜头'],
});

const ANGLE = table({
  eye: ['eye level', 'eyelevel', 'eye_level', 'eye-level', 'level', 'neutral', '平视', '平拍'],
  low: ['low angle', 'low_angle', 'worms eye', '仰拍', '仰视', '低机位'],
  high: ['high angle', 'high_angle', '俯拍', '高机位'],
  overhead: ['birds eye', 'bird eye', 'birdseye', 'top down', 'top_down', 'top', '顶拍', '鸟瞰'],
  dutch: ['dutch angle', 'dutch tilt', 'canted', 'tilted', '斜角', '倾斜'],
});

const LENS = table({
  wide: ['wide angle', 'wide_angle', 'wideangle', '广角'],
  normal: ['standard', 'normal lens', '标准'],
  tele: ['telephoto', 'long lens', 'tele lens', '长焦'],
});

const MOVEMENT = table({
  static: ['fixed', 'locked', 'locked off', 'locked_off', 'lockoff', 'still', 'none', 'no movement', 'tripod', '固定', '静止'],
  push_in: ['push in', 'push-in', 'dolly in', 'dolly_in', 'push', 'zoom in', '推', '推近'],
  pull_out: ['pull out', 'pull-out', 'dolly out', 'dolly_out', 'pull back', 'pull_back', 'zoom out', '拉', '拉远'],
  pan: ['panning', 'pan left', 'pan right', '摇', '横摇'],
  tilt: ['tilt up', 'tilt down', '俯仰', '纵摇'],
  track: ['tracking', 'tracking shot', 'dolly', 'follow', 'following', 'truck', '跟', '跟拍', '移'],
  crane: ['jib', 'boom', 'crane shot', '升降', '摇臂'],
  handheld: ['hand held', 'hand-held', '手持'],
  vehicle: ['car mount', 'car_mount', 'vehicle mount', '车载'],
});

const TEMPLATE = table({
  establishing: ['establishing shot', 'establish', '建立镜头', '交代镜头'],
  single: ['single shot', 'one shot', '单人'],
  two_shot: ['two shot', '2 shot', '2shot', 'twoshot', '双人'],
  ots: ['over the shoulder', 'over-the-shoulder', 'over_shoulder', 'overshoulder', '过肩'],
  insert: ['insert shot', '插入'],
  lateral_move: ['lateral', 'lateral move', 'lateral movement', '横移'],
  scale: ['scale shot', '尺度'],
});

const SCREEN = table({ L: ['left', 'screen left', '左'], C: ['center', 'centre', 'middle', '中'], R: ['right', 'screen right', '右'] });
const DEPTH = table({ fg: ['foreground', '前景'], mg: ['midground', 'middle ground', 'middleground', '中景'], bg: ['background', '背景', '远景'] });
const FACING = table({
  camera: ['toward camera', 'towards camera', 'front', 'facing camera', '正面'],
  away: ['back', 'away from camera', 'back to camera', '背面', '背对'],
  screen_left: ['left', 'screen left', 'profile left'],
  screen_right: ['right', 'screen right', 'profile right'],
  '3q_left': ['3/4 left', 'three quarter left', 'three_quarter_left', '3q left', 'threequarter left'],
  '3q_right': ['3/4 right', 'three quarter right', 'three_quarter_right', '3q right', 'threequarter right'],
});
const POSE = table({
  stand: ['standing', '站'],
  walk: ['walking', '走'],
  run: ['running', '跑'],
  sit: ['sitting', 'seated', '坐'],
  point: ['pointing', '指'],
  crouch: ['crouching', 'squat', 'squatting', '蹲'],
});
const PROP = table({
  door: ['doors', '门'],
  table: ['tables', 'desk', 'counter', '桌'],
  chair: ['chairs', 'seat', '椅'],
  car: ['cars', 'vehicle', '车'],
  wall: ['walls', '墙'],
  building: ['buildings', '建筑'],
  stairs: ['stair', 'staircase', 'steps', '楼梯'],
  window: ['windows', '窗'],
  box: ['boxes', 'crate', '箱'],
});
const ENV = table({
  open: ['outdoor', 'outdoors', 'exterior', 'ext', 'outside', '室外', '外景'],
  interior: ['indoor', 'indoors', 'inside', 'int', '室内', '内景'],
  street: ['road', '街道', '街'],
});
const SUBJECT_MOTION = table({
  none: ['static', 'still', 'no motion', '无'],
  l2r: ['left to right', 'left_to_right', 'l->r', 'l→r', 'ltr', '左到右', '从左到右'],
  r2l: ['right to left', 'right_to_left', 'r->l', 'r→l', 'rtl', '右到左', '从右到左'],
  toward: ['towards', 'toward camera', 'towards camera', 'approach', 'approaching', '朝向镜头', '走近'],
  away: ['away from camera', 'receding', 'leaving', '远离', '离开'],
});

const FRAME_FORMATS = ['2.39', '2.20', '1.90', '1.78', '1.43'];

function mapEnum(v: Json, t: Map<string, string>): Json {
  if (typeof v !== 'string') return v;
  return t.get(key(v)) ?? v;
}

/** "", "null", "none", "n/a" → null for nullable string/enum fields */
function nullish(v: Json): Json {
  if (v === undefined) return null;
  if (typeof v === 'string' && /^(|null|none|n\/a|无)$/i.test(v.trim())) return null;
  return v;
}

function mapNullableEnum(v: Json, t: Map<string, string>): Json {
  const n = nullish(v);
  return n === null ? null : mapEnum(n, t);
}

function toNumber(v: Json): Json {
  if (typeof v !== 'string') return v;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds|秒|mm|毫米)?\s*$/i.exec(v);
  return m ? Number(m[1]) : v;
}

function toBool(v: Json): Json {
  if (typeof v !== 'string') return v;
  const k = v.trim().toLowerCase();
  if (k === 'true' || k === 'yes' || k === '是') return true;
  if (k === 'false' || k === 'no' || k === '否') return false;
  return v;
}

function frameFormat(v: Json): Json {
  const n = nullish(v);
  if (n === null) return null;
  const s = typeof n === 'number' ? String(n) : typeof n === 'string' ? n.trim().replace(/\s*:\s*1$/, '') : null;
  if (s === null) return n;
  const num = Number(s);
  if (!Number.isFinite(num)) return n;
  return FRAME_FORMATS.find((f) => Number(f) === num) ?? n;
}

function arr(v: Json): Json {
  return v === undefined || v === null ? [] : v;
}

function normalizeSubject(s: Json): Json {
  if (typeof s === 'string') return { alias: s.trim(), screen: null, depth: null, facing: null, pose: null };
  if (!isRec(s)) return s;
  return {
    ...s,
    alias: typeof s.alias === 'string' ? s.alias.trim() : s.alias,
    screen: mapNullableEnum(s.screen, SCREEN),
    depth: mapNullableEnum(s.depth, DEPTH),
    facing: mapNullableEnum(s.facing, FACING),
    pose: mapNullableEnum(s.pose, POSE),
  };
}

export function normalizeShotFieldsJson(shot: Json): Json {
  if (!isRec(shot)) return shot;
  const out: Rec = { ...shot };
  out.template = mapNullableEnum(shot.template, TEMPLATE);
  out.shot_size = mapEnum(shot.shot_size, SHOT_SIZE);
  out.angle = mapEnum(shot.angle, ANGLE);
  out.lens = mapEnum(shot.lens, LENS);
  out.focal_mm = toNumber(nullish(shot.focal_mm));
  out.movement = mapEnum(shot.movement, MOVEMENT);
  const subjects = arr(shot.subjects);
  out.subjects = Array.isArray(subjects) ? subjects.map(normalizeSubject) : subjects;
  const props = arr(shot.props);
  out.props = Array.isArray(props) ? props.map((p) => mapEnum(p, PROP)) : props;
  out.env = mapNullableEnum(shot.env, ENV);
  out.subject_motion = mapEnum(shot.subject_motion, SUBJECT_MOTION);
  out.set_piece = toBool(shot.set_piece);
  out.pov_owner = nullish(shot.pov_owner);
  if (typeof out.pov_owner === 'string') out.pov_owner = out.pov_owner.trim();
  out.frame_format = frameFormat(shot.frame_format);
  out.technique_id = nullish(shot.technique_id);
  out.est_seconds = toNumber(shot.est_seconds);
  out.dialogue_quote = nullish(shot.dialogue_quote);
  out.assumptions = arr(shot.assumptions);
  out.questions = arr(shot.questions);
  if (isRec(shot.source) && typeof shot.source.paragraph_id === 'string') {
    out.source = { ...shot.source, paragraph_id: shot.source.paragraph_id.trim() };
  }
  return out;
}

/** Normalise a raw BreakdownOutput candidate. A bare array is wrapped as { shots }. */
export function normalizeBreakdownJson(raw: unknown): unknown {
  const root: Json = Array.isArray(raw) ? { shots: raw } : raw;
  if (!isRec(root)) return root;
  const shots = root.shots;
  if (!Array.isArray(shots)) return root;
  return { ...root, shots: shots.map(normalizeShotFieldsJson) };
}

/** Normalise a raw EntitiesOutput candidate: missing lists → [], missing aliases → []. */
export function normalizeEntitiesJson(raw: unknown): unknown {
  if (!isRec(raw)) return raw;
  const fix = (list: Json): Json =>
    Array.isArray(list)
      ? list.map((e) =>
          typeof e === 'string'
            ? { name: e.trim(), aliases: [] }
            : isRec(e)
              ? { ...e, name: typeof e.name === 'string' ? e.name.trim() : e.name, aliases: arr(e.aliases) }
              : e,
        )
      : list === undefined || list === null
        ? []
        : list;
  return { ...raw, characters: fix(raw.characters), locations: fix(raw.locations), props: fix(raw.props) };
}
