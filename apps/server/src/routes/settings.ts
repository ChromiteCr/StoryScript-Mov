import type { Hono } from 'hono';
import type { z } from 'zod';
import { canEditGroupModel, groupModelDir, ownModelDir, requireLeader, type ModelSettingsDir } from '../collab/models.ts';
import { Api, ProviderTestResult, ProvidersView, SaveImageProviderInput, SaveTextProviderInput, TestImageProviderInput } from '@storyscript/contracts';
import { redactSecrets } from '../adapters/llm/redact.ts';
import { imageProviderView, resolveImageProvider, saveImageProvider } from '../config/image-provider.ts';
import { resolveTextProvider, saveTextProvider, textProviderView } from '../config/text-provider.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';
import { checkPublicBaseUrl, EgressBlockedError } from '../security/egress.ts';
import { testImageProvider } from '../services/raster/provider-test.ts';

/**
 * Provider settings (M3: text, M8: image). The key is write-only: responses
 * carry base_url, model, the last 4 characters of the key and where it came
 * from; the image view adds the detected dialect / preset and host warnings.
 */

const MODELS_TIMEOUT_MS = 10_000;

/** Hosted server: a group's base_url must be a public https address (the fetch enforces it again at connect time). */
async function assertReachable(deps: AppDeps, baseUrl: string): Promise<void> {
  if (!deps.hosted) return;
  const problem = await checkPublicBaseUrl(baseUrl);
  if (problem) throw new AppError('VALIDATION_ERROR', `base_url 不能用：${problem}`, 400, { field: 'base_url' });
}

/** The group's settings (locally: the only settings). A hosted member sees them without the key digits and cannot edit. */
function view(deps: AppDeps) {
  const editable = canEditGroupModel(deps);
  const text = textProviderView(deps.stateDir, deps.env);
  const image = imageProviderView(deps.stateDir, deps.env);
  return {
    text: text && !editable ? { ...text, key_last4: null } : text,
    image: image && !editable ? { ...image, key_last4: null } : image,
    editable,
  };
}

/** S4 hosted: the signed-in account's own settings (its folder is chosen by the gateway, never by the browser). */
function ownDir(deps: AppDeps): ModelSettingsDir {
  const where = deps.hosted ? ownModelDir() : null;
  if (!where) throw new AppError('NOT_FOUND', '只有服务器版有「我的模型」', 404);
  return where;
}

function ownView(where: ModelSettingsDir) {
  return { text: textProviderView(where.dir, where.env), image: imageProviderView(where.dir, where.env), editable: true };
}

/** Free check: GET {base}/models (no chat call, no tokens). */
async function testText(deps: AppDeps, where: ModelSettingsDir): Promise<z.infer<typeof ProviderTestResult>> {
  if (deps.demo) return { ok: false, models_endpoint: false, model_listed: null, message: '演示模式不会外发任何请求' };
  const r = resolveTextProvider(where.dir, where.env);
  if (!r.base_url || !r.api_key || !r.model) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', '尚未配置文本模型：请填写 base_url、API key 和模型名', 409);
  }
  const url = `${r.base_url.replace(/\/+$/, '')}/models`;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      headers: { Authorization: `Bearer ${r.api_key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof EgressBlockedError ? err.message : err instanceof Error && err.name === 'TimeoutError' ? '连接超时' : '无法连接';
    return { ok: false, models_endpoint: false, model_listed: null, message: redactSecrets(`${reason}：${r.base_url}`, [r.api_key]) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, models_endpoint: true, model_listed: null, message: `密钥无效或没有权限（HTTP ${res.status}）` };
  }
  if (!res.ok) {
    return { ok: false, models_endpoint: false, model_listed: null, message: `该服务的 /models 不可用（HTTP ${res.status}），无法免费检查；可以直接试用拆镜` };
  }
  let ids: string[] | null = null;
  try {
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    if (Array.isArray(body.data)) ids = body.data.map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
  } catch {
    ids = null;
  }
  if (ids === null) return { ok: true, models_endpoint: true, model_listed: null, message: '连接成功，但 /models 没有返回模型列表' };
  const listed = ids.includes(r.model);
  return {
    ok: listed,
    models_endpoint: true,
    model_listed: listed,
    message: listed ? `连接成功，模型 ${r.model} 可用` : `连接成功，但模型列表中没有 ${r.model}，请核对模型名`,
  };
}

export function registerSettingsRoutes(app: Hono, deps: AppDeps): void {
  app.get(Api.getProviders.path, (c) => respond(c, ProvidersView, view(deps)));

  app.put(Api.saveTextProvider.path, async (c) => {
    requireLeader(deps);
    const input = await parseBody(c, SaveTextProviderInput);
    await assertReachable(deps, input.base_url);
    saveTextProvider(deps.stateDir, input);
    const r = resolveTextProvider(deps.stateDir, deps.env);
    const notice = r.env_fields.length
      ? `已保存到 credentials.json；但环境变量 ${r.env_fields.map((f) => `STORYSCRIPT_LLM_${f.toUpperCase()}`).join('、')} 优先生效`
      : undefined;
    return respond(c, ProvidersView, view(deps), 200, notice ? { notice } : undefined);
  });

  /** Free check of the group's model (members may run it too: it spends nothing). */
  app.post(Api.testTextProvider.path, async (c) => respond(c, ProviderTestResult, await testText(deps, groupModelDir(deps))));

  // ---- M8: image provider -------------------------------------------------

  app.put(Api.saveImageProvider.path, async (c) => {
    requireLeader(deps);
    const input = await parseBody(c, SaveImageProviderInput);
    await assertReachable(deps, input.base_url);
    saveImageProvider(deps.stateDir, input);
    const r = resolveImageProvider(deps.stateDir, deps.env);
    const notice = r.env_fields.length
      ? `已保存到 credentials.json；但环境变量 ${r.env_fields.map((f) => `STORYSCRIPT_IMAGE_${f.toUpperCase()}`).join('、')} 优先生效`
      : undefined;
    return respond(c, ProvidersView, view(deps), 200, notice ? { notice } : undefined);
  });

  /** paid=false: GET {base}/models only; paid=true: one smallest, lowest-quality image (confirmed by the caller). */
  app.post(Api.testImageProvider.path, async (c) => {
    const input = await parseBody(c, TestImageProviderInput);
    // a paid test spends the group's money: leader only
    if (input.paid) requireLeader(deps);
    return respond(c, ProviderTestResult, await testImageProvider(deps, input.paid, groupModelDir(deps)));
  });

  // ---- S4 hosted: my own model (never shown to the group) ------------------

  app.get(Api.getMyProviders.path, (c) => respond(c, ProvidersView, ownView(ownDir(deps))));

  app.put(Api.saveMyTextProvider.path, async (c) => {
    const where = ownDir(deps);
    const input = await parseBody(c, SaveTextProviderInput);
    await assertReachable(deps, input.base_url);
    saveTextProvider(where.dir, input);
    return respond(c, ProvidersView, ownView(where));
  });

  app.post(Api.testMyTextProvider.path, async (c) => respond(c, ProviderTestResult, await testText(deps, ownDir(deps))));

  app.put(Api.saveMyImageProvider.path, async (c) => {
    const where = ownDir(deps);
    const input = await parseBody(c, SaveImageProviderInput);
    await assertReachable(deps, input.base_url);
    saveImageProvider(where.dir, input);
    return respond(c, ProvidersView, ownView(where));
  });

  app.post(Api.testMyImageProvider.path, async (c) => {
    const where = ownDir(deps);
    const input = await parseBody(c, TestImageProviderInput);
    return respond(c, ProviderTestResult, await testImageProvider(deps, input.paid, where));
  });
}
