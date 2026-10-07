/**
 * Lenient pre-normalisation of model output before zod (SPEC FR-03 step 2).
 * Only mechanical fixes: enum case and a small synonym table, missing nullable
 * fields → null, missing arrays → [], numeric strings → numbers. It never
 * guesses content: unknown values are left as they are so zod reports them and
 * the repair round can fix them.
 */
import type { PropKind } from '@storyscript/contracts';

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
  orbit: ['环绕', '环拍', '绕拍', 'arc', 'arc shot', '360'],
  aerial: ['航拍', '无人机', 'drone', 'aerial shot'],
  dolly_zoom: ['变焦推拉', '滑动变焦', 'dolly zoom', 'vertigo', 'zolly'],
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
  lie: ['lying', 'lying down', 'lie down', 'laying', 'prone', 'supine', '躺', '躺着', '卧'],
  kneel: ['kneeling', 'on knees', 'on one knee', '跪', '跪着', '跪下'],
  reach: ['reaching', 'reach out', 'reaching out', '伸手'],
  phone: ['on phone', 'on the phone', 'phoning', 'calling', 'phone call', '打电话', '接电话'],
});
// S5b: the seven emotions a board can show
const EMOTION = table({
  neutral: ['calm', 'none', 'normal', 'neutral face', '平静', '中性', '无表情', '面无表情', '冷静'],
  happy: ['joy', 'joyful', 'smile', 'smiling', 'glad', 'excited', 'laughing', '开心', '高兴', '喜悦', '快乐', '兴奋', '微笑', '笑'],
  sad: ['sadness', 'upset', 'crying', 'grief', 'sorrow', 'down', '难过', '悲伤', '伤心', '哭', '失落', '沮丧'],
  angry: ['anger', 'mad', 'furious', 'rage', 'annoyed', '生气', '愤怒', '恼怒', '发火'],
  afraid: ['fear', 'scared', 'frightened', 'terrified', 'fearful', '害怕', '恐惧', '惊恐', '畏惧'],
  surprised: ['surprise', 'shocked', 'shock', 'astonished', 'stunned', '吃惊', '惊讶', '震惊', '惊愕'],
  tense: ['nervous', 'anxious', 'worried', 'uneasy', 'tension', 'stressed', '紧张', '不安', '焦虑', '担心', '忐忑'],
});
const PROP_WORDS: Record<PropKind, readonly string[]> = {
  door: ['doors', '门'],
  table: ['tables', 'desk', 'counter', '桌'],
  chair: ['chairs', 'seat', '椅'],
  car: ['cars', 'vehicle', '车'],
  wall: ['walls', '墙'],
  building: ['buildings', '建筑'],
  stairs: ['stair', 'staircase', 'steps', '楼梯'],
  window: ['windows', '窗'],
  box: ['boxes', 'crate', '箱'],
  bed: ['beds', '床'],
  sofa: ['sofas', 'couch', 'couches', 'settee', '沙发'],
  shelf: ['shelves', 'bookshelf', 'bookshelves', 'bookcase', 'shelving', '书架', '货架', '架子'],
  lamp: ['lamps', 'floor lamp', 'desk lamp', 'street lamp', 'streetlight', 'lamp post', '灯', '台灯', '路灯'],
  tree: ['trees', '树'],
  phone: ['phones', 'mobile', 'mobile phone', 'cellphone', 'cell phone', 'smartphone', 'telephone', '手机', '电话'],
  cup: ['cups', 'mug', 'mugs', 'teacup', 'coffee cup', '杯', '杯子', '茶杯'],
  book: ['books', 'diary', '书', '本子', '日记本'],
  bag: ['bags', 'backpack', 'handbag', 'schoolbag', 'satchel', '包', '书包', '背包'],
  can: ['cans', 'tin', 'tin can', 'tins', 'jar', 'jars', 'canister', '罐', '罐子', '罐头', '易拉罐', '铁罐', '玻璃罐'],
  bottle: ['bottles', 'flask', 'vial', '瓶', '瓶子', '酒瓶', '水瓶', '药瓶', '饮料瓶'],
};
const PROP = table(PROP_WORDS);

/** Chinese prop words, longest first (书架 before 书). */
const PROP_CJK: readonly { word: string; kind: PropKind }[] = (Object.entries(PROP_WORDS) as [PropKind, readonly string[]][])
  .flatMap(([kind, words]) => words.filter((w) => /[\u4e00-\u9fff]/.test(w)).map((word) => ({ word, kind })))
  .sort((a, b) => b.word.length - a.word.length || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

/**
 * S5b: the prop kinds a Chinese name speaks of (黄桃罐头 → can, 日记本 → book,
 * 书架 → shelf, not book): longest words first, each character counted once.
 * An empty list for a name that says nothing about its shape (热咖啡, 信).
 */
export function propKindsInName(name: string): PropKind[] {
  const taken = new Array<boolean>(name.length).fill(false);
  const kinds = new Set<PropKind>();
  for (const { word, kind } of PROP_CJK) {
    let from = 0;
    for (;;) {
      const at = name.indexOf(word, from);
      if (at < 0) break;
      from = at + 1;
      let free = true;
      for (let i = at; i < at + word.length; i++) if (taken[i]) free = false;
      if (!free) continue;
      for (let i = at; i < at + word.length; i++) taken[i] = true;
      kinds.add(kind);
    }
  }
  return [...kinds];
}
const ENV = table({
  open: ['outdoor', 'outdoors', 'exterior', 'ext', 'outside', '室外', '外景'],
  interior: ['indoor', 'indoors', 'inside', 'int', '室内', '内景'],
  street: ['road', '街道', '街'],
  nature: ['forest', 'woods', 'woodland', 'wilderness', 'countryside', 'mountain', '野外', '树林', '森林', '山林', '郊外'],
  corridor: ['hallway', 'passage', 'passageway', 'hall way', '走廊', '过道', '楼道'],
  classroom: ['class room', '教室'],
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
  const out: Rec = {
    ...s,
    alias: typeof s.alias === 'string' ? s.alias.trim() : s.alias,
    screen: mapNullableEnum(s.screen, SCREEN),
    depth: mapNullableEnum(s.depth, DEPTH),
    facing: mapNullableEnum(s.facing, FACING),
    pose: mapNullableEnum(s.pose, POSE),
  };
  // S5b: emotion is optional — absent stays absent
  if (s.emotion !== undefined) out.emotion = mapNullableEnum(s.emotion, EMOTION);
  return out;
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
  // camera_notes is optional: absent stays absent; blank text becomes null.
  if (shot.camera_notes !== undefined) {
    out.camera_notes = typeof shot.camera_notes === 'string' ? (shot.camera_notes.trim() === '' ? null : shot.camera_notes.trim()) : shot.camera_notes;
  }
  // S5b object_name: optional like camera_notes
  if (shot.object_name !== undefined) {
    out.object_name = typeof shot.object_name === 'string' ? (shot.object_name.trim() === '' ? null : shot.object_name.trim()) : shot.object_name;
  }
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
