import type { Hono } from 'hono';
import { Api, ProviderTestResult, ProvidersView, SaveTextProviderInput } from '@storyscript/contracts';
import { redactSecrets } from '../adapters/llm/redact.ts';
import { resolveTextProvider, saveTextProvider, textProviderView } from '../config/text-provider.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../http/errors.ts';
import { respond } from '../http/respond.ts';
import { parseBody } from '../http/validate.ts';

/**
 * Provider settings (M3: text only). The key is write-only: responses carry
 * base_url, model, the last 4 characters of the key and where it came from.
 */

const MODELS_TIMEOUT_MS = 10_000;

function view(deps: AppDeps) {
  return { text: textProviderView(deps.stateDir, deps.env), image: null };
}

export function registerSettingsRoutes(app: Hono, deps: AppDeps): void {
  app.get(Api.getProviders.path, (c) => respond(c, ProvidersView, view(deps)));

  app.put(Api.saveTextProvider.path, async (c) => {
    const input = await parseBody(c, SaveTextProviderInput);
    saveTextProvider(deps.stateDir, input);
    const r = resolveTextProvider(deps.stateDir, deps.env);
    const notice = r.env_fields.length
      ? `已保存到 credentials.json；但环境变量 ${r.env_fields.map((f) => `STORYSCRIPT_LLM_${f.toUpperCase()}`).join('、')} 优先生效`
      : undefined;
    return respond(c, ProvidersView, view(deps), 200, notice ? { notice } : undefined);
  });

  /** Free check: GET {base}/models (no chat call, no tokens). */
  app.post(Api.testTextProvider.path, async (c) => {
    if (deps.demo) {
      return respond(c, ProviderTestResult, {
        ok: false,
        models_endpoint: false,
        model_listed: null,
        message: '演示模式不会外发任何请求',
      });
    }
    const r = resolveTextProvider(deps.stateDir, deps.env);
    if (!r.base_url || !r.api_key || !r.model) {
      throw new AppError('PROVIDER_NOT_CONFIGURED', '尚未配置文本模型：请填写 base_url、API key 和模型名', 409);
    }
    const url = `${r.base_url.replace(/\/+$/, '')}/models`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${r.api_key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? '连接超时' : '无法连接';
      return respond(c, ProviderTestResult, {
        ok: false,
        models_endpoint: false,
        model_listed: null,
        message: redactSecrets(`${reason}：${r.base_url}`, [r.api_key]),
      });
    }
    if (res.status === 401 || res.status === 403) {
      return respond(c, ProviderTestResult, { ok: false, models_endpoint: true, model_listed: null, message: `密钥无效或没有权限（HTTP ${res.status}）` });
    }
    if (!res.ok) {
      return respond(c, ProviderTestResult, {
        ok: false,
        models_endpoint: false,
        model_listed: null,
        message: `该服务的 /models 不可用（HTTP ${res.status}），无法免费检查；可以直接试用拆镜`,
      });
    }
    let ids: string[] | null = null;
    try {
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      if (Array.isArray(body.data)) ids = body.data.map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
    } catch {
      ids = null;
    }
    if (ids === null) {
      return respond(c, ProviderTestResult, { ok: true, models_endpoint: true, model_listed: null, message: '连接成功，但 /models 没有返回模型列表' });
    }
    const listed = ids.includes(r.model);
    return respond(c, ProviderTestResult, {
      ok: listed,
      models_endpoint: true,
      model_listed: listed,
      message: listed ? `连接成功，模型 ${r.model} 可用` : `连接成功，但模型列表中没有 ${r.model}，请核对模型名`,
    });
  });
}
