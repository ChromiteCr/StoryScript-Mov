import type { Board, BoardSpec, BoardView, Entity, ImageDialect, ImageProviderView, Job, RasterView, ShotFields } from '@storyscript/contracts';
import { buildImagePrompt, structureHash, type ImagePrompt } from '@storyscript/core';
import type { InputOf } from './api.ts';
import { describeJobError } from './errors.ts';
import { MAX_ATTEMPTS, usageText } from './jobs.ts';

/**
 * AI pencil redraw (FR-12, experimental) — display labels and pure helpers
 * for the settings page and the board page. Stored values stay the
 * contracts' English enums; everything here is display-only or derived.
 * `test/at18-web-raster.test.ts` covers the helpers.
 */

export type RasterStatus = RasterView['status'];
export type RasterOutcome = RasterView['outcome'];
export type RedrawQuality = InputOf<'requestRedraw'>['quality'];

// ------------------------------------------------------------------ labels

export const DIALECT_LABEL: Record<ImageDialect, string> = {
  'openai-edits': 'openai-edits（图像编辑接口）',
  'generations-ref': 'generations-ref（生成接口 + 参考图）',
};

export const DIALECT_HINT: Record<ImageDialect, string> = {
  'openai-edits': 'POST {base_url}/images/edits，multipart 上传控制图',
  'generations-ref': '按 preset 调用生成接口，控制图作为参考图随 JSON 发送',
};

/** The dialect select of the settings form: auto = detect from the host name. */
export type DialectChoice = 'auto' | ImageDialect;

export const DIALECT_CHOICES: readonly { value: DialectChoice; label: string }[] = [
  { value: 'auto', label: '自动识别（按主机名）' },
  { value: 'openai-edits', label: '强制 openai-edits' },
  { value: 'generations-ref', label: '强制 generations-ref' },
];

export const PRESET_LABEL: Readonly<Record<string, string>> = {
  'volcengine-seedream': '火山方舟 Seedream',
  openrouter: 'OpenRouter',
  'generic-generations': '通用 generations（兜底）',
};

export function presetLabel(id: string | null): string | null {
  if (!id) return null;
  return PRESET_LABEL[id] ?? id;
}

export const RASTER_STATUS_LABEL: Record<RasterStatus, string> = {
  candidate: '候选',
  adopted: '已采用',
  rejected: '已拒绝',
};

export const RASTER_OUTCOME_LABEL: Record<RasterOutcome, string> = {
  ok: '已生成',
  refused: '被服务拒绝',
  outcome_unknown: '结果未知',
  late_after_cancel: '取消后晚到',
};

export const QUALITY_LABEL: Record<RedrawQuality, string> = {
  low: '低（最省）',
  medium: '中',
  high: '高',
};

export const QUALITIES: readonly RedrawQuality[] = ['low', 'medium', 'high'];

/** Stale raster: the board's structure changed after it was drawn. */
export const STALE_TITLE = '镜头构图已改，AI 图可能不再对应';
export const STALE_DETAIL = '不会自动重绘。需要时再点"AI 铅笔重绘"，或切到"只看线稿"。';

/** What leaves the machine on a redraw (settings page and confirmation dialog). */
export const SENT_DATA = '控制图（由同一份分镜渲染，不含文字、镜号和箭头）+ 镜头的文字描述（景别、机位、人物位置与朝向、动作说明）';
export const NOT_SENT_DATA = '原片、剧本全文和角色名（提示词里以 Person 1、Person 2… 代替）';
export const COST_NOTE = '费用以服务商账单为准';

/** Common image endpoints (docs/providers.md). None of them is verified with a real key. */
export const IMAGE_PROVIDER_PRESETS: readonly { name: string; base_url: string; note: string }[] = [
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', note: 'openai-edits · 未验证' },
  { name: '火山方舟 Seedream', base_url: 'https://ark.cn-beijing.volces.com/api/v3', note: 'generations-ref · 未验证' },
  { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', note: 'generations-ref，比例枚举 · 未验证' },
];

// ------------------------------------------------------------ small helpers

export function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

export function validHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "openai-edits（图像编辑接口）" or "generations-ref（…）· 火山方舟 Seedream". */
export function dialectText(view: Pick<ImageProviderView, 'dialect' | 'preset_id'>): string {
  const preset = presetLabel(view.preset_id);
  return preset ? `${DIALECT_LABEL[view.dialect]} · ${preset}` : DIALECT_LABEL[view.dialect];
}

/** Settings view → the form's dialect select value. */
export function dialectChoiceOf(view: Pick<ImageProviderView, 'dialect_override'> | null): DialectChoice {
  return view?.dialect_override ?? 'auto';
}

export function dialectOverrideOf(choice: DialectChoice): ImageDialect | null {
  return choice === 'auto' ? null : choice;
}

/** Every image service is unverified until someone runs it with a real key (docs/providers.md). */
export function verifiedText(view: Pick<ImageProviderView, 'verified'>): string {
  return view.verified ? '已用真实服务验证' : '未验证';
}

/** "输入 1,200 · 输出 4,160 tokens", or "用量未知" when the service reported nothing. */
export function rasterUsageText(usage: Record<string, number> | null): string {
  return usageText(usage) ?? '用量未知';
}

export function rasterTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

// ------------------------------------------------------ confirmation preview

export interface RedrawPreview {
  /** host (and port) of the image service */
  host: string;
  dialect: ImageDialect;
  preset: string | null;
  verified: boolean;
  model: string;
  warning: string | null;
  /** the quality parameter is only sent by openai-edits */
  sendsQuality: boolean;
  prompt: ImagePrompt;
  /** camera / people / setting / action lines of the prompt */
  summary: string[];
}

const SUMMARY_LINE = /^(Camera|People|Setting|Action|镜头|人物|场景|动作)[:：( ]/;

/**
 * What the confirmation dialog shows before anything is sent. The prompt is
 * compiled here by the same core function the server uses (default English);
 * the server compiles it again from the saved board, so the dialog labels the
 * full text as a preview.
 */
export function redrawPreview(
  spec: BoardSpec,
  fields: ShotFields | undefined,
  view: ImageProviderView,
  entities: readonly Entity[] = [],
): RedrawPreview {
  // Same roster as the server (every character), so names and aliases are
  // replaced in the preview exactly as in the request.
  const roster = entities.filter((e) => e.type === 'character').map((e) => ({ entity_id: e.id, name: e.name, aliases: e.aliases }));
  const prompt = buildImagePrompt({ spec, shot: fields ?? null, lang: 'en', padded: false, style_anchor: false, roster });
  return {
    host: hostOf(view.base_url) ?? view.base_url,
    dialect: view.dialect,
    preset: presetLabel(view.preset_id),
    verified: view.verified,
    model: view.model,
    warning: view.warning,
    sendsQuality: view.dialect === 'openai-edits',
    prompt,
    summary: prompt.text.split('\n').filter((l) => SUMMARY_LINE.test(l)),
  };
}

/** Why the redraw entry is disabled (null = available). */
export function redrawBlockedReason(p: {
  demo: boolean;
  configured: boolean;
  dirty: boolean;
  viewingOld: boolean;
}): string | null {
  if (p.demo) return '演示模式不提供 AI 重绘，也不会外发任何请求。';
  if (!p.configured) return '未配置图像模型：在"设置 → 模型"中填写图像服务后可用。铅笔稿本身不需要它。';
  if (p.viewingOld) return '正在查看旧版本：回到最新版本后才能重绘。';
  if (p.dirty) return '有未保存的修改：AI 重绘使用已保存的分镜，请先保存为新版本。';
  return null;
}

// ------------------------------------------------------------- job states

export interface RedrawJobView {
  tone: 'info' | 'ok' | 'warn' | 'danger';
  title: string;
  detail: string | null;
  /** still queued or running: polling continues */
  busy: boolean;
  /** the request may have been processed and billed */
  unknown: boolean;
}

export const OUTCOME_UNKNOWN_TITLE = '结果未知，为避免重复计费不会自动重发';
const OUTCOME_UNKNOWN_DETAIL = '请求已经发出，但没有收到结果（超时或连接中断），服务可能已处理并计费。可以到服务商控制台核对；需要时再手动点一次"AI 铅笔重绘"。';

export function redrawJobView(job: Pick<Job, 'status' | 'attempts' | 'error' | 'remote'>): RedrawJobView {
  const unknownCode = job.error?.code === 'PROVIDER_OUTCOME_UNKNOWN';
  switch (job.status) {
    case 'queued':
      return { tone: 'info', title: 'AI 重绘排队中', detail: '同一时间只发送一个付费请求，前面的任务完成后开始。', busy: true, unknown: false };
    case 'running':
      return {
        tone: 'info',
        title: 'AI 重绘进行中',
        detail: job.attempts > 0 ? `已外发 ${job.attempts} 次（每步上限 ${MAX_ATTEMPTS} 次），通常需要几十秒。` : '正在准备控制图和提示词…',
        busy: true,
        unknown: false,
      };
    case 'succeeded':
      return { tone: 'ok', title: '已生成 1 张候选图', detail: '在候选列表里对照后决定是否采用；不会自动采用。', busy: false, unknown: false };
    case 'outcome_unknown':
      return { tone: 'warn', title: OUTCOME_UNKNOWN_TITLE, detail: OUTCOME_UNKNOWN_DETAIL, busy: false, unknown: true };
    case 'interrupted':
      return job.attempts > 0
        ? { tone: 'warn', title: OUTCOME_UNKNOWN_TITLE, detail: OUTCOME_UNKNOWN_DETAIL, busy: false, unknown: true }
        : { tone: 'info', title: '任务被中断', detail: '服务重启时请求还没有发出，没有产生费用，可以重新发起。', busy: false, unknown: false };
    case 'cancelled':
      return { tone: 'info', title: '已取消', detail: '请求还没有发出，没有产生费用。', busy: false, unknown: false };
    case 'failed': {
      if (unknownCode) return { tone: 'warn', title: OUTCOME_UNKNOWN_TITLE, detail: OUTCOME_UNKNOWN_DETAIL, busy: false, unknown: true };
      const human = describeJobError(job.error);
      return {
        tone: 'danger',
        title: `AI 重绘失败${human ? `：${human.title}` : ''}`,
        detail: human?.detail ?? job.error?.message ?? null,
        busy: false,
        unknown: false,
      };
    }
  }
}

// --------------------------------------------------------- shot's rasters

/** A raster of any version of the selected shot's board. */
export interface ShotRaster extends RasterView {
  board_version: number;
  /** belongs to the shot's newest board version */
  current: boolean;
}

/** Rasters of several board versions → one list, newest first. */
export function mergeShotRasters(groups: readonly { board: Pick<Board, 'id' | 'version'>; rasters: readonly RasterView[] }[], currentBoardId: string): ShotRaster[] {
  const out: ShotRaster[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const r of g.rasters) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, board_version: g.board.version, current: r.board_id === currentBoardId });
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.board_version - a.board_version || (a.id < b.id ? -1 : 1));
}

/** The adopted raster of the board version shown (adoption is per board version). */
export function adoptedRaster<T extends Pick<RasterView, 'id' | 'board_id' | 'status'>>(list: readonly T[], board: Pick<BoardView, 'id' | 'adopted_raster_id'>): T | null {
  if (board.adopted_raster_id) {
    const hit = list.find((r) => r.id === board.adopted_raster_id);
    if (hit) return hit;
  }
  return list.find((r) => r.board_id === board.id && r.status === 'adopted') ?? null;
}

/** Adopted raster of an older version of this shot (left behind by a structure change). */
export function leftBehindAdopted(list: readonly ShotRaster[]): ShotRaster | null {
  return list.find((r) => !r.current && r.status === 'adopted') ?? null;
}

/** Stale against what the canvas shows now (the server flag, or unsaved structure edits). */
export function rasterStaleFor(r: Pick<RasterView, 'stale' | 'structure_hash'>, spec: BoardSpec): boolean {
  return r.stale || r.structure_hash !== structureHash(spec);
}

export function adoptBlockedReason(r: Pick<ShotRaster, 'current' | 'image_url' | 'status' | 'outcome' | 'board_version'>): string | null {
  if (r.status === 'adopted') return '已采用';
  if (!r.image_url) return `没有可用的图像（${RASTER_OUTCOME_LABEL[r.outcome]}），不能采用`;
  if (!r.current) return `这张图属于旧版本 v${r.board_version}，采用只对那个版本生效；需要时请重新生成`;
  return null;
}

// ------------------------------------------------------ canvas AI display

/**
 * How the big frame shows an AI raster:
 *  - overlay: AI raster + the vector annotation layer (adopted default)
 *  - onion:   raster over the structure / pencil frame at an adjustable opacity
 *  - ai:      the raster alone
 *  - lines:   the structure / pencil frame alone
 */
export type AiViewMode = 'overlay' | 'onion' | 'ai' | 'lines';

export const AI_VIEW_LABEL: Record<AiViewMode, string> = {
  overlay: 'AI 图 + 标注',
  onion: '叠加对比',
  ai: '只看 AI 图',
  lines: '只看线稿',
};

export const AI_VIEW_MODES: readonly AiViewMode[] = ['overlay', 'onion', 'ai', 'lines'];

/** Onion-skin opacity: 0–100 %, in steps of 5. */
export function clampOpacity(pct: number): number {
  if (!Number.isFinite(pct)) return 50;
  return Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
}
