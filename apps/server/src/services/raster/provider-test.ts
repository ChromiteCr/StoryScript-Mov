import type { ProviderTestResult } from '@storyscript/contracts';
import { formatSize, pickAspectValue, smallestPixelSize } from '@storyscript/core';
import { callImage } from '../../adapters/image/call.ts';
import type { ImageEndpoint, ImageQuality, ImageRequest } from '../../adapters/image/types.ts';
import { redactSecrets } from '../../adapters/llm/redact.ts';
import { svgToPng } from '../../adapters/render/resvg.ts';
import type { AppDeps } from '../../deps.ts';
import { redrawOptions } from './options.ts';
import { imageOverrides, requireImageClient, USER_AGENT } from './runtime.ts';

/**
 * Image provider connection test.
 *   paid=false: free check only — GET {base}/models, then look for the model.
 *   paid=true : the caller already confirmed; one image at the smallest legal
 *               size and the lowest quality, same retry policy as a redraw.
 *               Nothing is stored.
 */

const MODELS_TIMEOUT_MS = 10_000;

const TEST_PROMPT = 'Connection test: redraw image 1 as a simple loose pencil sketch of one box on paper. Monochrome. No text, no numbers, no logo, no watermark.';

async function testControl(size: number): Promise<Uint8Array> {
  const s = size;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">` +
    `<rect x="0" y="0" width="${s}" height="${s}" fill="#f0f0f0"/>` +
    `<rect x="${s * 0.3}" y="${s * 0.35}" width="${s * 0.4}" height="${s * 0.35}" fill="none" stroke="#202020" stroke-width="${Math.max(2, s / 128)}"/>` +
    `</svg>`;
  return svgToPng(svg, { width: s });
}

function summarizeUsage(usage: Record<string, number> | null): string {
  if (!usage) return '服务未返回用量';
  return Object.entries(usage)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v}`)
    .join('，');
}

async function freeCheck(cfg: ReturnType<typeof requireImageClient>, warning: string): Promise<ProviderTestResult> {
  const url = `${cfg.base_url.replace(/\/+$/, '')}/models`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.api_key}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? '连接超时' : '无法连接';
    return { ok: false, models_endpoint: false, model_listed: null, message: redactSecrets(`${reason}：${cfg.base_url}${warning}`, [cfg.api_key]) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, models_endpoint: true, model_listed: null, message: `密钥无效或没有权限（HTTP ${res.status}）${warning}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      models_endpoint: false,
      model_listed: null,
      message: `该服务的 /models 不可用（HTTP ${res.status}），无法免费检查；可以在确认费用后做一次付费测试${warning}`,
    };
  }
  let ids: string[] | null = null;
  try {
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    if (Array.isArray(body.data)) ids = body.data.map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
  } catch {
    ids = null;
  }
  if (ids === null) return { ok: true, models_endpoint: true, model_listed: null, message: `连接成功，但 /models 没有返回模型列表${warning}` };
  const listed = ids.includes(cfg.model);
  return {
    ok: listed && !cfg.blocking,
    models_endpoint: true,
    model_listed: listed,
    message: `${listed ? `连接成功，模型 ${cfg.model} 可用` : `连接成功，但模型列表中没有 ${cfg.model}，请核对模型名`}${warning}`,
  };
}

export async function testImageProvider(deps: AppDeps, paid: boolean): Promise<ProviderTestResult> {
  if (deps.demo) return { ok: false, models_endpoint: false, model_listed: null, message: '演示模式不会外发任何请求' };
  const cfg = requireImageClient(deps, { forRedraw: false });
  const warning = cfg.warning ? `（注意：${cfg.warning}）` : '';
  if (!paid) return freeCheck(cfg, warning);

  const endpoint: ImageEndpoint = { base_url: cfg.base_url, api_key: cfg.api_key, model: cfg.model, dialect: cfg.dialect, preset: cfg.preset, host: cfg.host };
  let size: string;
  let quality: ImageQuality | null = null;
  let controlEdge = 512;
  if (cfg.dialect === 'openai-edits' || !cfg.preset) {
    size = '1024x1024';
    quality = 'low';
    controlEdge = 1024;
  } else if (cfg.preset.size_mode === 'aspect_enum') {
    size = cfg.preset.aspect_values.includes('1:1') ? '1:1' : (pickAspectValue(1, cfg.preset.aspect_values) ?? '1:1');
  } else {
    const db = deps.projectSession.get()?.db;
    size = formatSize(smallestPixelSize(db ? redrawOptions(db).pixel_window : undefined));
  }
  const req: ImageRequest = { prompt: TEST_PROMPT, images: [{ bytes: await testControl(controlEdge), mime: 'image/png', name: 'control.png' }], size, quality };
  const o = imageOverrides(deps);
  const res = await callImage(endpoint, req, {
    timeoutMs: o.timeoutMs,
    sleep: o.sleep,
    retryAfterCapMs: o.retryAfterCapMs,
    defaultRetryAfterMs: o.defaultRetryAfterMs,
    userAgent: USER_AGENT,
    attempt: o.attempt,
  });
  if (res.outcome === 'ok') {
    const dims = res.image.width && res.image.height ? `${res.image.width}×${res.image.height}` : '尺寸未知';
    return {
      ok: !cfg.blocking,
      models_endpoint: false,
      model_listed: null,
      message: `付费测试成功：服务返回了 1 张 ${dims} 的图像（${res.image.mime}，请求尺寸 ${size}）；用量：${summarizeUsage(res.usage)}；费用以服务商账单为准${warning}`,
    };
  }
  const message = res.outcome === 'cancelled' ? '测试已取消' : res.error.message;
  return { ok: false, models_endpoint: false, model_listed: null, message: redactSecrets(`付费测试失败：${message}${warning}`, [cfg.api_key]) };
}
