import { describe, expect, it } from 'vitest';
import type { BoardSpec, Entity, ImageProviderView, Job, RasterView } from '@storyscript/contracts';
import { ImageDialect, RasterOutcome, RasterStatus } from '@storyscript/contracts';
import { renderBoard, STANDARD_SHOTS, standardBoard, structureHash } from '@storyscript/core';
import {
  adoptBlockedReason,
  adoptedRaster,
  AI_VIEW_LABEL,
  AI_VIEW_MODES,
  clampOpacity,
  DIALECT_CHOICES,
  DIALECT_LABEL,
  dialectChoiceOf,
  dialectOverrideOf,
  dialectText,
  hostOf,
  leftBehindAdopted,
  mergeShotRasters,
  OUTCOME_UNKNOWN_TITLE,
  QUALITIES,
  QUALITY_LABEL,
  RASTER_OUTCOME_LABEL,
  RASTER_STATUS_LABEL,
  rasterStaleFor,
  rasterUsageText,
  redrawBlockedReason,
  redrawJobView,
  redrawPreview,
  validHttpUrl,
  verifiedText,
} from '../src/lib/labels-raster.ts';
import { AI_LABEL_PREF_KEY, aiLabelPrefKey, rasterImageUrl, readAiLabelPref } from '../src/lib/queries-raster.ts';
import { AI_BADGE_TEXT, aiBadgeBox, overlayOnlySvg, renderOverlayOnly } from '../src/views/boards/raster-layers.ts';

/**
 * AT-18 (web side, FakeImage E2E in e2e/at18-redraw.spec.ts): the pure parts
 * of the AI pencil redraw UI — labels for every enum, the confirmation
 * preview (host, dialect, filtered words, summary), job states (result
 * unknown is never re-sent), the shot's raster list across board versions,
 * adoption per version, stale against unsaved edits, the annotation-only
 * layer and the "AI 生成" corner mark, and the export preference (default on).
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const spec: BoardSpec = standardBoard(STANDARD_SHOTS.find((s) => s.key === '10-depth-two')!);
const BOARD_V1 = id(1);
const BOARD_V2 = id(2);

function raster(n: number, over: Partial<RasterView> = {}): RasterView {
  return {
    id: id(100 + n),
    board_id: BOARD_V2,
    structure_hash: structureHash(spec),
    dialect: 'openai-edits',
    host: '127.0.0.1',
    model: 'fake-image-model',
    preset_id: null,
    size: '1840x768',
    quality: 'low',
    prompt_hash: 'p',
    control_sha256: 'c',
    file: `boards/x/raster-${n}.png`,
    sha256: 's',
    status: 'candidate',
    outcome: 'ok',
    usage: { input_tokens: 1200, output_tokens: 4160, total_tokens: 5360 },
    ai_label_on: true,
    source_type: 'model_generated',
    created_at: `2026-09-26T08:0${n}:00.000Z`,
    image_url: `/api/v1/rasters/${id(100 + n)}/image`,
    stale: false,
    ...over,
  };
}

const view: ImageProviderView = {
  base_url: 'http://127.0.0.1:43210/v1',
  model: 'fake-image-model',
  key_last4: '1098',
  source: 'file',
  dialect_override: null,
  dialect: 'openai-edits',
  preset_id: null,
  verified: false,
  warning: null,
};

function job(over: Partial<Job>): Pick<Job, 'status' | 'attempts' | 'error' | 'remote'> {
  return { status: 'queued', attempts: 0, error: null, remote: true, ...over };
}

describe('labels', () => {
  it('every enum value has a Chinese label', () => {
    for (const d of ImageDialect.options) expect(DIALECT_LABEL[d]).toMatch(/[一-鿿]/);
    for (const s of RasterStatus.options) expect(RASTER_STATUS_LABEL[s]).toMatch(/[一-鿿]/);
    for (const o of RasterOutcome.options) expect(RASTER_OUTCOME_LABEL[o]).toMatch(/[一-鿿]/);
    for (const q of QUALITIES) expect(QUALITY_LABEL[q]).toBeTruthy();
    for (const m of AI_VIEW_MODES) expect(AI_VIEW_LABEL[m]).toBeTruthy();
    expect(AI_VIEW_LABEL.ai).toBe('只看 AI 图');
    expect(AI_VIEW_LABEL.lines).toBe('只看线稿');
    expect(DIALECT_CHOICES.map((c) => c.value)).toEqual(['auto', 'openai-edits', 'generations-ref']);
  });

  it('dialect select ↔ dialect_override', () => {
    expect(dialectChoiceOf(null)).toBe('auto');
    expect(dialectChoiceOf({ dialect_override: 'generations-ref' })).toBe('generations-ref');
    expect(dialectOverrideOf('auto')).toBeNull();
    expect(dialectOverrideOf('openai-edits')).toBe('openai-edits');
    expect(dialectText({ dialect: 'generations-ref', preset_id: 'volcengine-seedream' })).toContain('火山方舟 Seedream');
    expect(dialectText({ dialect: 'openai-edits', preset_id: null })).toBe(DIALECT_LABEL['openai-edits']);
    expect(verifiedText({ verified: false })).toBe('未验证');
  });

  it('hosts and URLs', () => {
    expect(hostOf('http://127.0.0.1:43210/v1')).toBe('127.0.0.1:43210');
    expect(hostOf('https://ark.cn-beijing.volces.com/api/v3')).toBe('ark.cn-beijing.volces.com');
    expect(hostOf('not a url')).toBeNull();
    expect(validHttpUrl(' https://api.openai.com/v1 ')).toBe(true);
    expect(validHttpUrl('ftp://x')).toBe(false);
  });

  it('usage: tokens, or 用量未知', () => {
    expect(rasterUsageText({ input_tokens: 1200, output_tokens: 4160, total_tokens: 5360 })).toBe('输入 1,200 · 输出 4,160 tokens');
    expect(rasterUsageText(null)).toBe('用量未知');
    expect(rasterUsageText({ total_tokens: 0 })).toBe('用量未知');
  });

  it('onion opacity clamps to 0–100 in steps of 5', () => {
    expect(clampOpacity(52)).toBe(50);
    expect(clampOpacity(-10)).toBe(0);
    expect(clampOpacity(130)).toBe(100);
    expect(clampOpacity(Number.NaN)).toBe(50);
  });
});

describe('confirmation preview', () => {
  it('host, dialect, model, unverified, and the words filtered out of the shot text', () => {
    const fields = { ...STANDARD_SHOTS.find((s) => s.key === '10-depth-two')!.fields, action: '甲把《某片》的旧海报递给乙，IMAX 风格' };
    const p = redrawPreview(spec, fields, view);
    expect(p.host).toBe('127.0.0.1:43210');
    expect(p.dialect).toBe('openai-edits');
    expect(p.model).toBe('fake-image-model');
    expect(p.verified).toBe(false);
    expect(p.sendsQuality).toBe(true);
    expect(p.prompt.removed).toEqual(expect.arrayContaining(['《某片》', 'imax']));
    expect(p.prompt.text).not.toContain('《某片》');
    // summary: camera / people / setting / action lines only
    expect(p.summary.length).toBeGreaterThanOrEqual(3);
    expect(p.summary.every((l) => /^(Camera|People|Setting|Action)/.test(l))).toBe(true);
    expect(p.summary.some((l) => l.startsWith('People: exactly 2 people'))).toBe(true);
  });

  it('generations-ref sends no quality; preset and warning pass through', () => {
    const p = redrawPreview(spec, undefined, { ...view, dialect: 'generations-ref', preset_id: 'openrouter', warning: '该地址不接收参考图，不能用于草图重绘' });
    expect(p.sendsQuality).toBe(false);
    expect(p.preset).toBe('OpenRouter');
    expect(p.warning).toContain('不接收参考图');
  });

  it('names and aliases in the preview are replaced exactly as the server replaces them', () => {
    const named: BoardSpec = structuredClone(spec);
    named.scene.subjects[0]!.entity_id = id(201);
    named.scene.subjects[0]!.label = '周明远';
    named.scene.subjects[1]!.entity_id = id(202);
    named.scene.subjects[1]!.label = '林晓';
    const entity = (n: number, name: string, aliases: string[]): Entity => ({
      id: id(n), type: 'character', alias: `c${n - 200}`, name, aliases, origin: 'manual', confirmed: true,
    });
    const entities = [entity(201, '周明远', ['老周']), entity(202, '林晓', []), entity(203, '沈映秋', ['外婆'])];
    const fields = { ...STANDARD_SHOTS.find((s) => s.key === '10-depth-two')!.fields, action: '老周把外婆的信递给林晓' };
    const p = redrawPreview(named, fields, view, entities);
    for (const n of ['周明远', '老周', '林晓', '沈映秋', '外婆']) expect(p.prompt.text).not.toContain(n);
    expect(p.prompt.text).toContain('Person 1');
    expect(p.prompt.text).toContain('an off-screen person');
  });

  it('why the entry is disabled', () => {
    expect(redrawBlockedReason({ demo: false, configured: false, dirty: false, viewingOld: false })).toContain('未配置图像模型');
    expect(redrawBlockedReason({ demo: true, configured: true, dirty: false, viewingOld: false })).toContain('演示模式');
    expect(redrawBlockedReason({ demo: false, configured: true, dirty: true, viewingOld: false })).toContain('先保存');
    expect(redrawBlockedReason({ demo: false, configured: true, dirty: false, viewingOld: true })).toContain('旧版本');
    expect(redrawBlockedReason({ demo: false, configured: true, dirty: false, viewingOld: false })).toBeNull();
  });
});

describe('redraw job states', () => {
  it('queued / running keep polling', () => {
    expect(redrawJobView(job({ status: 'queued' }))).toMatchObject({ busy: true, title: 'AI 重绘排队中' });
    const running = redrawJobView(job({ status: 'running', attempts: 1 }));
    expect(running.busy).toBe(true);
    expect(running.detail).toContain('已外发 1 次');
  });

  it('result unknown (timeout, cancel after sending, restart) is never re-sent', () => {
    const cases = [
      job({ status: 'outcome_unknown', attempts: 1, error: { code: 'PROVIDER_OUTCOME_UNKNOWN', message: '...' } }),
      job({ status: 'failed', attempts: 1, error: { code: 'PROVIDER_OUTCOME_UNKNOWN', message: '图像服务在 120 秒内没有响应' } }),
      job({ status: 'interrupted', attempts: 1 }),
    ];
    for (const c of cases) {
      const v = redrawJobView(c);
      expect(v).toMatchObject({ busy: false, unknown: true, tone: 'warn', title: OUTCOME_UNKNOWN_TITLE });
      expect(v.title).toContain('为避免重复计费不会自动重发');
    }
    expect(redrawJobView(job({ status: 'interrupted', attempts: 0 })).unknown).toBe(false);
  });

  it('failures say why', () => {
    const v = redrawJobView(job({ status: 'failed', attempts: 1, error: { code: 'PROVIDER_REFUSED', message: '内容审核拒绝' } }));
    expect(v.tone).toBe('danger');
    expect(v.detail).toContain('内容审核拒绝');
    expect(redrawJobView(job({ status: 'succeeded', attempts: 1 })).tone).toBe('ok');
    expect(redrawJobView(job({ status: 'cancelled' })).detail).toContain('没有产生费用');
  });
});

describe("the shot's rasters", () => {
  const v1 = { id: BOARD_V1, version: 1 };
  const v2 = { id: BOARD_V2, version: 2 };
  const old = raster(1, { board_id: BOARD_V1, status: 'adopted', stale: true, structure_hash: 'old' });
  const a = raster(2);
  const b = raster(3, { status: 'rejected' });
  const unknown = raster(4, { outcome: 'outcome_unknown', file: null, sha256: null, image_url: null, usage: null });

  it('merge every version, newest first, marking the current one', () => {
    const list = mergeShotRasters(
      [
        { board: v2, rasters: [unknown, b, a] },
        { board: v1, rasters: [old] },
      ],
      BOARD_V2,
    );
    expect(list.map((r) => r.id)).toEqual([unknown.id, b.id, a.id, old.id]);
    expect(list.map((r) => [r.board_version, r.current])).toEqual([
      [2, true],
      [2, true],
      [2, true],
      [1, false],
    ]);
  });

  it('adoption is per board version; an older adopted raster is left behind', () => {
    const list = mergeShotRasters([{ board: v2, rasters: [a] }, { board: v1, rasters: [old] }], BOARD_V2);
    expect(adoptedRaster(list, { id: BOARD_V2, adopted_raster_id: null })).toBeNull();
    expect(leftBehindAdopted(list)?.id).toBe(old.id);
    const adoptedList = mergeShotRasters([{ board: v2, rasters: [{ ...a, status: 'adopted' }] }], BOARD_V2);
    expect(adoptedRaster(adoptedList, { id: BOARD_V2, adopted_raster_id: a.id })?.id).toBe(a.id);
    // the list can run ahead of the board list (just adopted)
    expect(adoptedRaster(adoptedList, { id: BOARD_V2, adopted_raster_id: null })?.id).toBe(a.id);
  });

  it('what can be adopted', () => {
    const [r] = mergeShotRasters([{ board: v2, rasters: [a] }], BOARD_V2);
    expect(adoptBlockedReason(r!)).toBeNull();
    const [u] = mergeShotRasters([{ board: v2, rasters: [unknown] }], BOARD_V2);
    expect(adoptBlockedReason(u!)).toContain('结果未知');
    const [o] = mergeShotRasters([{ board: v1, rasters: [{ ...old, status: 'candidate' }] }], BOARD_V2);
    expect(adoptBlockedReason(o!)).toContain('旧版本 v1');
  });

  it('stale: the server flag, or a structure edit not saved yet (annotations do not count)', () => {
    expect(rasterStaleFor(a, spec)).toBe(false);
    expect(rasterStaleFor({ ...a, stale: true }, spec)).toBe(true);
    const moved: BoardSpec = { ...spec, scene: { ...spec.scene, subjects: spec.scene.subjects.map((s, i) => (i === 0 ? { ...s, x: s.x + 0.4 } : s)) } };
    expect(rasterStaleFor(a, moved)).toBe(true);
    const relabelled: BoardSpec = { ...spec, overlay: { ...spec.overlay, labels: [{ id: 'l1', text: '新标签', x: 0.5, y: 0.5 }] } };
    expect(rasterStaleFor(a, relabelled)).toBe(false);
  });
});

describe('layers over the raster', () => {
  it('annotation-only SVG: the overlay group without the picture, same root, no <style>', () => {
    const full = renderBoard(spec, 'pencil', { overlay: true, code: '004' });
    const svg = overlayOnlySvg(full, spec);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg.slice(0, svg.indexOf('>'))).toBe(full.slice(0, full.indexOf('>')));
    expect(svg).toContain('data-layer="overlay"');
    expect(svg).toContain('data-code');
    expect(svg).not.toContain('data-layer="picture"');
    expect(svg).not.toMatch(/<style|style=/);
    expect(svg.length).toBeLessThan(full.length / 3);
    expect(renderOverlayOnly(spec, '004')).toBe(svg);
    // a picture without an overlay still gives a valid (frame-only) SVG
    const bare = overlayOnlySvg(renderBoard(spec, 'pencil', { overlay: false }), spec);
    expect(bare).toMatch(/^<svg[^>]*><rect[^>]*\/><\/svg>$/);
  });

  it('corner mark sits under the shot code when the code is shown', () => {
    const withCode = aiBadgeBox({ ...spec, overlay: { ...spec.overlay, show_code: true } }, '004');
    const noCode = aiBadgeBox({ ...spec, overlay: { ...spec.overlay, show_code: false } }, '004');
    expect(noCode.y).toBe(14);
    expect(withCode.y).toBeGreaterThan(55);
    expect(withCode.x).toBe(noCode.x);
    expect(withCode.w).toBeGreaterThan(80);
    expect(withCode.baseline).toBeGreaterThan(withCode.y);
    expect(withCode.baseline).toBeLessThan(withCode.y + withCode.h);
    expect(AI_BADGE_TEXT).toBe('AI 生成');
  });
});

describe('export preference for the "AI 生成" mark (M7 switch shares the keys)', () => {
  const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null });
  const P = id(900);

  it('defaults to on; per project first, then the global value', () => {
    expect(readAiLabelPref(P, null)).toBe(true);
    expect(readAiLabelPref(P, store({}))).toBe(true);
    expect(readAiLabelPref(P, store({ [AI_LABEL_PREF_KEY]: 'off' }))).toBe(false);
    expect(readAiLabelPref(P, store({ [AI_LABEL_PREF_KEY]: 'off', [aiLabelPrefKey(P)]: 'on' }))).toBe(true);
    expect(readAiLabelPref(P, store({ [aiLabelPrefKey(P)]: 'off' }))).toBe(false);
    expect(readAiLabelPref(null, store({ [aiLabelPrefKey(P)]: 'off' }))).toBe(true);
  });

  it('unreadable storage means on', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readAiLabelPref(P, broken)).toBe(true);
  });

  it('raster image URL', () => {
    expect(rasterImageUrl(id(7))).toBe(`/api/v1/rasters/${id(7)}/image`);
  });
});
