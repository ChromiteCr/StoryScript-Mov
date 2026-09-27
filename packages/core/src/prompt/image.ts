/**
 * AI pencil redraw (SPEC FR-12, experimental): the image prompt and the size
 * arithmetic of the three request dialects. Pure — no IO, byte-identical
 * output for identical input.
 *
 * Prompt (IMAGE_PROMPT_VERSION): a fixed skeleton with field interpolation —
 * task, look, camera, people ("exactly N people", screen third, depth,
 * facing, pose), setting (environment, key light), filtered free text and a
 * fixed avoid list. Everything positional comes from the BoardSpec (the same
 * spec the control image is rendered from); ShotFields only contribute shot
 * size, camera angle, movement and the action line. Character names never
 * leave: people are "Person 1…N" and their labels in the action text are
 * replaced by those tags; the action text also passes stripTriggerTerms.
 *
 * Sizes: openai-edits sends exact 16-multiple sizes (aspect ≤ 3:1);
 * aspect_enum services get the nearest ratio and a padded control image;
 * pixel services (Seedream) get W×H inside a configurable pixel window. The
 * board frame's box on the canvas is recorded so the returned image can be
 * cropped back to the frame and the vector annotation layer stays aligned.
 */
import type { BoardSpec, CameraAngle, EnvKind, FrameFormat, Movement, Pose, PropKind, ShotFields, ShotSize } from '@storyscript/contracts';
import { contentHash } from '../util/hash.ts';
import { aspectValue } from '../board/camera.ts';
import { isEnvProp, relativeYaw } from '../board/layout.ts';
import { subjectBands, type DepthBand } from '../board/pencil-plan.ts';
import { subjectFrameBoxes } from '../board/render.ts';
import { stripTriggerTerms } from './claims.ts';

export const IMAGE_PROMPT_VERSION = 'image-v1';

export type ImagePromptLang = 'en' | 'zh';

export interface ImagePromptInput {
  spec: BoardSpec;
  /** the shot's semantic fields (null: camera words come from the spec alone) */
  shot: Pick<ShotFields, 'shot_size' | 'angle' | 'movement' | 'action'> | null;
  lang?: ImagePromptLang;
  /** a second input image is attached as a style anchor */
  style_anchor?: boolean;
  /** the control image carries plain paper margins around the frame */
  padded?: boolean;
  /**
   * Every character's name and aliases (entity_id links on-screen subjects).
   * No character name may reach the image service: on-screen people become
   * "Person k", anyone else "an off-screen person" — aliases included.
   */
  roster?: readonly { entity_id: string | null; name: string; aliases: readonly string[] }[];
}

export interface ImagePromptPerson {
  /** BoardSubject.id */
  id: string;
  screen: 'left' | 'center' | 'right';
  depth: DepthBand;
  /** relative yaw bucket */
  facing: 'camera' | 'away' | '3q_right' | '3q_left' | 'right' | 'left' | 'back_3q_right' | 'back_3q_left';
  pose: Pose;
}

export interface ImagePrompt {
  version: typeof IMAGE_PROMPT_VERSION;
  lang: ImagePromptLang;
  text: string;
  /** trigger terms / titles removed from free text (shown to the user) */
  removed: string[];
  /** people visible in the frame, left to right */
  people: ImagePromptPerson[];
  /** contentHash of the text (the server records a sha256 as well) */
  hash: string;
}

// ---------------------------------------------------------------------------
// vocabularies
// ---------------------------------------------------------------------------

const EN_SIZE: Record<ShotSize, string> = {
  EWS: 'extreme wide shot',
  WS: 'wide shot',
  FS: 'full shot',
  MLS: 'medium long shot',
  MS: 'medium shot',
  MCU: 'medium close-up',
  CU: 'close-up',
  ECU: 'extreme close-up',
  INSERT: 'insert detail shot',
};
const ZH_SIZE: Record<ShotSize, string> = {
  EWS: '大远景',
  WS: '远景',
  FS: '全景',
  MLS: '中全景',
  MS: '中景',
  MCU: '近景',
  CU: '特写',
  ECU: '大特写',
  INSERT: '插入细节镜头',
};

const EN_ANGLE: Record<CameraAngle, string> = {
  eye: 'eye-level camera',
  low: 'low camera looking up',
  high: 'high camera looking down',
  overhead: 'overhead top-down camera',
  dutch: 'tilted dutch-angle camera',
};
const ZH_ANGLE: Record<CameraAngle, string> = {
  eye: '平视机位',
  low: '低机位仰拍',
  high: '高机位俯拍',
  overhead: '正上方顶拍',
  dutch: '倾斜的斜角机位',
};

const EN_MOVE: Record<Movement, string> = {
  static: 'static camera',
  push_in: 'slow push-in',
  pull_out: 'pull-out',
  pan: 'panning camera',
  tilt: 'tilting camera',
  track: 'tracking camera',
  crane: 'crane move',
  handheld: 'handheld camera',
  vehicle: 'camera hard-mounted on a vehicle',
};
const ZH_MOVE: Record<Movement, string> = {
  static: '固定机位',
  push_in: '缓推',
  pull_out: '拉出',
  pan: '横摇',
  tilt: '俯仰摇',
  track: '跟移',
  crane: '升降',
  handheld: '手持',
  vehicle: '车载硬挂机位',
};

const EN_POSE: Record<Pose, string> = { stand: 'standing', walk: 'walking', run: 'running', sit: 'sitting', point: 'pointing', crouch: 'crouching' };
const ZH_POSE: Record<Pose, string> = { stand: '站立', walk: '行走', run: '奔跑', sit: '坐着', point: '伸手指向', crouch: '蹲下' };

const EN_ENV: Record<EnvKind, string> = { open: 'open exterior landscape', interior: 'interior room', street: 'city street' };
const ZH_ENV: Record<EnvKind, string> = { open: '开阔的外景', interior: '室内', street: '城市街道' };

const EN_PROP: Record<PropKind, string> = {
  door: 'door',
  table: 'table',
  chair: 'chair',
  car: 'car',
  wall: 'wall',
  building: 'building',
  stairs: 'stairs',
  window: 'window',
  box: 'box',
};
const ZH_PROP: Record<PropKind, string> = {
  door: '门',
  table: '桌子',
  chair: '椅子',
  car: '汽车',
  wall: '墙',
  building: '楼房',
  stairs: '楼梯',
  window: '窗',
  box: '箱子',
};

const EN_SCREEN = { left: 'screen left', center: 'screen center', right: 'screen right' } as const;
const ZH_SCREEN = { left: '画面左侧', center: '画面中间', right: '画面右侧' } as const;
const EN_DEPTH: Record<DepthBand, string> = { fg: 'foreground', mg: 'midground', bg: 'background' };
const ZH_DEPTH: Record<DepthBand, string> = { fg: '前景', mg: '中景层', bg: '远景层' };
const EN_FACING: Record<ImagePromptPerson['facing'], string> = {
  camera: 'facing the camera',
  away: 'back to the camera',
  '3q_right': 'three-quarter view turned to screen right',
  '3q_left': 'three-quarter view turned to screen left',
  right: 'in profile facing screen right',
  left: 'in profile facing screen left',
  back_3q_right: 'seen from behind, turned to screen right',
  back_3q_left: 'seen from behind, turned to screen left',
};
const ZH_FACING: Record<ImagePromptPerson['facing'], string> = {
  camera: '面向镜头',
  away: '背对镜头',
  '3q_right': '3/4 侧身朝画右',
  '3q_left': '3/4 侧身朝画左',
  right: '正侧面朝画右',
  left: '正侧面朝画左',
  back_3q_right: '背侧身朝画右',
  back_3q_left: '背侧身朝画左',
};

const EN_AVOID = 'no text, no numbers, no arrows, no borders, no color, no logo, no watermark, no extra people, no grey mannequin look';
const ZH_AVOID = '不要文字、不要数字、不要箭头、不要边框、不要颜色、不要标志、不要水印、不要多余人物、不要灰色人体模型感';

// ---------------------------------------------------------------------------
// derived facts
// ---------------------------------------------------------------------------

function facingBucket(rel: number): ImagePromptPerson['facing'] {
  const a = Math.abs(rel);
  const right = rel > 0;
  if (a <= 22.5) return 'camera';
  if (a >= 157.5) return 'away';
  if (a <= 67.5) return right ? '3q_right' : '3q_left';
  if (a <= 112.5) return right ? 'right' : 'left';
  return right ? 'back_3q_right' : 'back_3q_left';
}

const SCREEN_LEFT_MAX = 0.42;
const SCREEN_RIGHT_MIN = 0.58;

/** People whose silhouette box intersects the frame, sorted left → right. */
export function visiblePeople(spec: BoardSpec): ImagePromptPerson[] {
  const boxes = subjectFrameBoxes(spec);
  const bands = new Map(subjectBands(spec).map((b) => [b.id, b.band]));
  const rows: { p: ImagePromptPerson; cx: number }[] = [];
  for (const s of spec.scene.subjects) {
    const b = boxes.get(s.id);
    if (!b) continue;
    if (b.x1 <= 0 || b.x0 >= b.W || b.y1 <= 0 || b.y0 >= b.H) continue;
    const cx = (Math.max(0, b.x0) + Math.min(b.W, b.x1)) / 2 / b.W;
    rows.push({
      cx,
      p: {
        id: s.id,
        // people staged on the thirds lines sit at ≈ 0.33 / 0.67: split at 0.42 / 0.58
        screen: cx < SCREEN_LEFT_MAX ? 'left' : cx > SCREEN_RIGHT_MIN ? 'right' : 'center',
        depth: bands.get(s.id) ?? 'mg',
        facing: facingBucket(relativeYaw(s, spec.camera)),
        pose: s.pose,
      },
    });
  }
  rows.sort((a, b) => a.cx - b.cx || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
  return rows.map((r) => r.p);
}

function lensWords(focal: number, lang: ImagePromptLang): string {
  const mm = Math.round(focal);
  if (lang === 'zh') {
    if (focal <= 30) return `广角镜头（约 ${mm}mm，纵深夸张）`;
    if (focal <= 60) return `标准镜头（约 ${mm}mm，透视自然）`;
    return `长焦镜头（约 ${mm}mm，空间压缩）`;
  }
  if (focal <= 30) return `wide-angle lens (about ${mm}mm, exaggerated depth)`;
  if (focal <= 60) return `normal lens (about ${mm}mm, natural perspective)`;
  return `telephoto lens (about ${mm}mm, compressed depth)`;
}

/** Light convention (core/board/pencil-plan): azimuth 0 = from behind the camera, + = toward camera-left. */
function lightWords(spec: BoardSpec, lang: ImagePromptLang): string {
  const az = ((((spec.scene.light.azimuth_deg + 180) % 360) + 360) % 360) - 180;
  const high = spec.scene.light.elevation_deg >= 65;
  const a = Math.abs(az);
  if (lang === 'zh') {
    const dir = a <= 30 ? '主光来自机位后方（正面光）' : a >= 150 ? '主光来自人物身后（逆光）' : az > 0 ? '主光来自画面左侧' : '主光来自画面右侧';
    return high ? `${dir}，光位很高` : dir;
  }
  const dir = a <= 30 ? 'key light from behind the camera (front light)' : a >= 150 ? 'key light from behind the subjects (backlight)' : az > 0 ? 'key light from screen left' : 'key light from screen right';
  return high ? `${dir}, high overhead` : dir;
}

function angleFromSpec(spec: BoardSpec): CameraAngle {
  const p = spec.camera.pitch_deg;
  if (p <= -60) return 'overhead';
  if (p <= -12) return 'high';
  if (p >= 12) return 'low';
  return Math.abs(spec.camera.roll_deg) >= 8 ? 'dutch' : 'eye';
}

/**
 * Replace every character name and alias with a neutral tag — on-screen
 * subjects become "Person k", everyone else "an off-screen person" — then
 * filter trigger terms. Longest names first, so "周明远" wins over "周".
 */
function cleanAction(
  text: string,
  spec: BoardSpec,
  people: ImagePromptPerson[],
  lang: ImagePromptLang,
  roster: ImagePromptInput['roster'] = [],
): { text: string; removed: string[] } {
  let out = text.replace(/\s+/g, ' ').trim();
  if (!out) return { text: '', removed: [] };
  const offscreen = lang === 'zh' ? '画外人物' : 'an off-screen person';
  const tags = new Map(people.map((p, i) => [p.id, lang === 'zh' ? `人物${i + 1}` : `Person ${i + 1}`]));
  const subjectTag = new Map<string, string>(); // entity_id → tag
  const names: { name: string; tag: string }[] = [];
  for (const s of spec.scene.subjects) {
    const tag = tags.get(s.id) ?? offscreen;
    if (s.entity_id) subjectTag.set(s.entity_id, tag);
    if (s.label.trim()) names.push({ name: s.label.trim(), tag });
  }
  for (const r of roster ?? []) {
    const tag = (r.entity_id && subjectTag.get(r.entity_id)) || offscreen;
    for (const n of [r.name, ...r.aliases]) if (n.trim()) names.push({ name: n.trim(), tag });
  }
  names.sort((a, b) => b.name.length - a.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, tag } of names) out = out.split(name).join(tag);
  const stripped = stripTriggerTerms(out);
  return { text: stripped.text.slice(0, 400), removed: stripped.removed };
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

export function buildImagePrompt(input: ImagePromptInput): ImagePrompt {
  const lang: ImagePromptLang = input.lang ?? 'en';
  const spec = input.spec;
  const people = visiblePeople(spec);
  const action = cleanAction(input.shot?.action ?? '', spec, people, lang, input.roster);
  const size = input.shot?.shot_size ?? null;
  const angle = input.shot?.angle ?? angleFromSpec(spec);
  const move: Movement = input.shot?.movement ?? spec.overlay.camera_move ?? 'static';
  const aspect = spec.frame.aspect;
  const props = [...new Set(spec.scene.props.filter((p) => !isEnvProp(p)).map((p) => p.kind))].sort();
  const lines: string[] = [];

  if (lang === 'zh') {
    lines.push('任务：把图 1 重绘为手绘铅笔分镜画格。严格保持图 1 的构图：机位与地平线、取景范围、人物数量、位置、大小和姿态都不变。图 1 只是布局参考，请用铅笔重新绘制。');
    if (input.style_anchor) lines.push('图 2 只作画风参考：只学习它的铅笔笔法，不要采用它的任何内容。');
    if (input.padded) lines.push('画格外的空白纸边保持空白。');
    lines.push(`画风：纸上松散的石墨铅笔分镜草图，单色，3–4 个灰阶，剪影清晰，方向一致的排线，保留构造线，宽银幕画幅（${aspect}:1）。`);
    lines.push(`镜头：${[size ? ZH_SIZE[size] : null, ZH_ANGLE[angle], lensWords(spec.camera.focal_mm, 'zh'), ZH_MOVE[move]].filter(Boolean).join('；')}。`);
    if (people.length === 0) {
      lines.push('人物：画面中没有人物。');
    } else {
      const each = people.map((p, i) => `人物${i + 1}：${ZH_SCREEN[p.screen]}，${ZH_DEPTH[p.depth]}，${ZH_FACING[p.facing]}，${ZH_POSE[p.pose]}`);
      lines.push(`人物：画面中恰好 ${people.length} 人（exactly ${people.length} ${people.length === 1 ? 'person' : 'people'}）。${each.join('；')}。`);
    }
    const env = ZH_ENV[spec.scene.env];
    lines.push(`场景：${env}${props.length ? `；道具：${props.map((k) => ZH_PROP[k]).join('、')}` : ''}；${lightWords(spec, 'zh')}。`);
    if (action.text) lines.push(`动作：${action.text}`);
    lines.push(`禁止：${ZH_AVOID}。`);
  } else {
    lines.push(
      'Task: redraw image 1 as a hand-drawn pencil storyboard frame. Keep the composition of image 1 exactly: the same camera position and horizon, the same framing, the same number of people in the same places, sizes and poses. Image 1 is only a layout guide; draw it again in pencil.',
    );
    if (input.style_anchor) lines.push('Image 2 is a style reference only: match its pencil technique and take nothing else from it.');
    if (input.padded) lines.push('Leave the plain paper margins outside the frame empty.');
    lines.push(
      `Style: loose graphite pencil storyboard sketch on paper, monochrome, 3–4 tonal values, strong silhouettes, directional hatching, construction lines, widescreen framing (${aspect}:1).`,
    );
    lines.push(`Camera: ${[size ? EN_SIZE[size] : null, EN_ANGLE[angle], lensWords(spec.camera.focal_mm, 'en'), EN_MOVE[move]].filter(Boolean).join('; ')}.`);
    if (people.length === 0) {
      lines.push('People: no people in the frame.');
    } else {
      const each = people.map((p, i) => `Person ${i + 1}: ${EN_SCREEN[p.screen]}, ${EN_DEPTH[p.depth]}, ${EN_FACING[p.facing]}, ${EN_POSE[p.pose]}`);
      lines.push(`People: exactly ${people.length} ${people.length === 1 ? 'person' : 'people'}. ${each.join('. ')}.`);
    }
    const env = EN_ENV[spec.scene.env];
    lines.push(`Setting: ${env}${props.length ? `; props: ${props.map((k) => EN_PROP[k]).join(', ')}` : ''}; ${lightWords(spec, 'en')}.`);
    if (action.text) lines.push(`Action (from the shot notes): ${action.text}`);
    lines.push(`Avoid: ${EN_AVOID}.`);
  }

  const text = lines.join('\n');
  return { version: IMAGE_PROMPT_VERSION, lang, text, removed: action.removed, people, hash: contentHash({ v: IMAGE_PROMPT_VERSION, text }) };
}

// ---------------------------------------------------------------------------
// sizes
// ---------------------------------------------------------------------------

export interface Size {
  w: number;
  h: number;
}

export const formatSize = (s: Size): string => `${s.w}x${s.h}`;

export function parseSize(v: string): Size | null {
  const m = /^\s*(\d{1,5})\s*[x×*]\s*(\d{1,5})\s*$/i.exec(v);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** "21:9" → 2.333… (null when malformed). */
export function parseAspect(v: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

/**
 * openai-edits: exact sizes per frame format — both edges multiples of 16,
 * aspect ≤ 3:1, about 1.2–1.45 MP (docs/research.md §3).
 */
export const OPENAI_EDIT_SIZES: Readonly<Record<FrameFormat, Size>> = {
  '2.39': { w: 1840, h: 768 },
  '2.20': { w: 1760, h: 800 },
  '1.90': { w: 1520, h: 800 },
  '1.78': { w: 1536, h: 864 },
  '1.43': { w: 1440, h: 1008 },
};

/** Standard sizes accepted by every GPT image model (fallback for older snapshots). */
export const OPENAI_STANDARD_SIZES: readonly Size[] = [
  { w: 1536, h: 1024 },
  { w: 1024, h: 1024 },
  { w: 1024, h: 1536 },
];

const OPENAI_MAX_EDGE = 3840;
const OPENAI_MAX_RATIO = 3;

const round16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

/** Nearest size satisfying the custom-size rules: 16-multiples, ratio ≤ 3:1, long edge ≤ 3840. */
export function legalOpenAISize(size: Size): Size {
  let r = size.w / size.h;
  r = Math.min(OPENAI_MAX_RATIO, Math.max(1 / OPENAI_MAX_RATIO, r));
  const px = Math.max(256 * 256, size.w * size.h);
  let w = Math.sqrt(px * r);
  let h = w / r;
  const over = Math.max(w, h) / OPENAI_MAX_EDGE;
  if (over > 1) {
    w /= over;
    h /= over;
  }
  let W = round16(w);
  let H = round16(h);
  // rounding may push the ratio just past 3:1
  while (W / H > OPENAI_MAX_RATIO) W -= 16;
  while (H / W > OPENAI_MAX_RATIO) H -= 16;
  return { w: W, h: H };
}

export function openaiEditSize(aspect: FrameFormat | number): Size {
  if (typeof aspect === 'string' && OPENAI_EDIT_SIZES[aspect]) return OPENAI_EDIT_SIZES[aspect];
  const r = aspectValue(aspect);
  return legalOpenAISize({ w: Math.sqrt(1840 * 768 * r), h: Math.sqrt((1840 * 768) / r) });
}

/** Standard size closest in aspect (log distance). */
export function nearestStandardOpenAISize(size: Size): Size {
  const r = Math.log(size.w / size.h);
  let best = OPENAI_STANDARD_SIZES[0] as Size;
  for (const s of OPENAI_STANDARD_SIZES) if (Math.abs(Math.log(s.w / s.h) - r) < Math.abs(Math.log(best.w / best.h) - r)) best = s;
  return best;
}

/** aspect_enum: the listed ratio closest to `ratio` (log distance; ties → first listed). */
export function pickAspectValue(ratio: number, values: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of values) {
    const a = parseAspect(v);
    if (a === null) continue;
    const d = Math.abs(Math.log(a) - Math.log(ratio));
    if (d < bestD - 1e-9) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/** Pixel window of a "pixels" service (Seedream: W×H inside a total-pixel range). Configurable. */
export interface PixelWindow {
  /** label only, e.g. "2K" */
  tier: string;
  target_pixels: number;
  min_pixels: number;
  max_pixels: number;
  /** both edges are rounded to this multiple */
  multiple: number;
}

/**
 * Unknown model → the 2K tier (≈ 2048² px). The floor covers the largest
 * documented minimum (≈ 3.69 MP for 5.0 lite, docs/research.md §3).
 */
export const DEFAULT_PIXEL_WINDOW: PixelWindow = {
  tier: '2K',
  target_pixels: 2048 * 2048,
  min_pixels: 3_686_400,
  max_pixels: 16_777_216,
  multiple: 16,
};

export function pixelSize(ratio: number, win: PixelWindow = DEFAULT_PIXEL_WINDOW): Size {
  const m = Math.max(1, Math.round(win.multiple));
  const target = Math.min(win.max_pixels, Math.max(win.min_pixels, win.target_pixels));
  let w = Math.round(Math.sqrt(target * ratio) / m) * m;
  let h = Math.round(Math.sqrt(target / ratio) / m) * m;
  // keep inside the window after rounding
  while (w * h < win.min_pixels) (w / h >= ratio ? (h += m) : (w += m));
  while (w * h > win.max_pixels) (w / h >= ratio ? (w -= m) : (h -= m));
  return { w: Math.max(m, w), h: Math.max(m, h) };
}

/** Smallest legal square of a pixel window (paid connection test). */
export function smallestPixelSize(win: PixelWindow = DEFAULT_PIXEL_WINDOW): Size {
  const m = Math.max(1, Math.round(win.multiple));
  const e = Math.ceil(Math.sqrt(win.min_pixels) / m) * m;
  return { w: e, h: e };
}

export type SizeMode = 'exact' | 'aspect_enum' | 'pixels';

export interface CanvasPlan {
  size_mode: SizeMode;
  /** value sent to the service: "1840x768", "21:9", "3168x1328" */
  request_size: string;
  /** control image size (px); same ratio as the requested output */
  canvas: Size;
  /** the board frame on the canvas (px, contain-fit, centred) */
  frame_box: { x: number; y: number; w: number; h: number };
  /** the same box as fractions of the canvas — applied to the returned image */
  crop: { x0: number; y0: number; x1: number; y1: number };
  /** plain margins around the frame (> 2 % of the canvas) */
  padded: boolean;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Contain-fit a frame of `frameAspect` into `canvas`, centred. */
export function fitFrame(frameAspect: number, canvas: Size, mode: SizeMode, requestSize: string): CanvasPlan {
  const cr = canvas.w / canvas.h;
  let w: number;
  let h: number;
  if (frameAspect >= cr) {
    w = canvas.w;
    h = canvas.w / frameAspect;
  } else {
    h = canvas.h;
    w = canvas.h * frameAspect;
  }
  const x = (canvas.w - w) / 2;
  const y = (canvas.h - h) / 2;
  return {
    size_mode: mode,
    request_size: requestSize,
    canvas,
    frame_box: { x: r2(x), y: r2(y), w: r2(w), h: r2(h) },
    crop: { x0: r6(x / canvas.w), y0: r6(y / canvas.h), x1: r6((x + w) / canvas.w), y1: r6((y + h) / canvas.h) },
    padded: 1 - (w * h) / (canvas.w * canvas.h) > 0.02,
  };
}

/** Long edge of the control image for ratio-only services. */
export const ASPECT_CONTROL_LONG_EDGE = 1536;
/** Widest control image for pixel services (the frame is 1840 px wide). */
export const CONTROL_MAX_W = 1840;

export type CanvasRequest =
  | { mode: 'exact' }
  | { mode: 'aspect_enum'; aspect_values: readonly string[] }
  | { mode: 'pixels'; window?: PixelWindow };

/** Request size + control canvas + crop box for a frame format and a dialect's size mode. */
export function planCanvas(aspect: FrameFormat | number, req: CanvasRequest): CanvasPlan {
  const ratio = aspectValue(aspect);
  if (req.mode === 'exact') {
    const s = openaiEditSize(aspect);
    return fitFrame(ratio, s, 'exact', formatSize(s));
  }
  if (req.mode === 'aspect_enum') {
    const v = pickAspectValue(ratio, req.aspect_values);
    const a = v === null ? ratio : (parseAspect(v) as number);
    const canvas = a >= 1 ? { w: ASPECT_CONTROL_LONG_EDGE, h: Math.round(ASPECT_CONTROL_LONG_EDGE / a) } : { w: Math.round(ASPECT_CONTROL_LONG_EDGE * a), h: ASPECT_CONTROL_LONG_EDGE };
    return fitFrame(ratio, canvas, 'aspect_enum', v ?? formatSize(canvas));
  }
  const s = pixelSize(ratio, req.window ?? DEFAULT_PIXEL_WINDOW);
  const k = Math.min(1, CONTROL_MAX_W / s.w);
  const canvas = { w: Math.round(s.w * k), h: Math.round(s.h * k) };
  return fitFrame(ratio, canvas, 'pixels', formatSize(s));
}
