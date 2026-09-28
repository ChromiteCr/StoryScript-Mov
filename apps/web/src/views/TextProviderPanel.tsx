import { useState, type FormEvent, type ReactNode } from 'react';
import type { ProviderTestResult, TextProviderView } from '@storyscript/contracts';
import { PlugZap, Save } from 'lucide-react';
import { useHealth, useProviders, useSaveTextProvider, useTestTextProvider } from '../lib/queries.ts';
import { SETTING_SOURCE_LABEL } from '../lib/labels.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Button, Field, Notice, Spinner, TextInput } from '../components/ui.tsx';
import { InspectorGroup, InspectorRow } from '../components/workspace.tsx';

/**
 * Settings → 模型 → 文本模型 (FR-03 BYOK, SPEC §6). The key is write-only:
 * the page only ever sees key_last4 and where the setting comes from.
 * Rendered as inspector groups inside the settings page's Inspector.
 */

interface Preset {
  name: string;
  base_url: string;
  note: string;
}

/** Common OpenAI-compatible endpoints (docs/research.md §2). Compatibility is not guaranteed. */
export const PROVIDER_PRESETS: readonly Preset[] = [
  { name: 'DeepSeek', base_url: 'https://api.deepseek.com', note: 'json_object 模式' },
  { name: '通义', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', note: '部分型号支持 json_schema；思考模式下可能失效' },
  { name: 'Kimi', base_url: 'https://api.moonshot.cn/v1', note: '支持 json_schema' },
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', note: '支持 json_schema strict' },
  { name: '本地 Ollama', base_url: 'http://127.0.0.1:11434/v1', note: 'JSON mode；key 可随意填写，例如 ollama' },
];

function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

function Dot({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-warn'}`} />
      <span>{children}</span>
    </span>
  );
}

function TestResult({ result }: { result: ProviderTestResult }) {
  return (
    <Notice tone={result.ok ? 'info' : 'warn'} role="status" title={result.ok ? '连接正常' : '连接未通过'}>
      <ul className="space-y-0.5">
        <li>模型列表接口：{result.models_endpoint ? '可以访问' : '无法访问'}</li>
        <li>
          配置的模型：
          {result.model_listed === null ? '服务没有提供模型列表，无法核对' : result.model_listed ? '在列表中找到' : '不在列表中，请核对模型名'}
        </li>
        {result.message ? <li className="break-words">说明：{result.message}</li> : null}
      </ul>
      <p className="mt-1.5 text-xs">这项检查只请求模型列表，不消耗 token。结构化输出的兼容性要在第一次拆镜时才能确认。</p>
    </Notice>
  );
}

interface ProviderFormProps {
  view: TextProviderView | null;
  /** owned by the panel so their state survives the form remount after a save */
  save: ReturnType<typeof useSaveTextProvider>;
  test: ReturnType<typeof useTestTextProvider>;
}

function ProviderForm({ view, save, test }: ProviderFormProps) {
  const hosted = useHealth().data?.hosted ?? false;
  // a hosted server only reaches public https services, so the local one is left out there
  const presets = hosted ? PROVIDER_PRESETS.filter((p) => p.base_url.startsWith('https://')) : PROVIDER_PRESETS;
  const fromEnv = view?.source === 'env';

  const [baseUrl, setBaseUrl] = useState(view?.base_url ?? '');
  const [model, setModel] = useState(view?.model ?? '');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [errors, setErrors] = useState<{ base_url?: string; model?: string }>({});

  const dirty = baseUrl.trim() !== (view?.base_url ?? '') || model.trim() !== (view?.model ?? '') || key !== '' || clearKey;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (fromEnv) return;
    const next: typeof errors = {};
    if (!validUrl(baseUrl)) next.base_url = '请填写完整的 http(s) 地址，例如 https://api.deepseek.com';
    if (model.trim() === '') next.model = '请填写模型名';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    test.reset();
    save.mutate(
      {
        base_url: baseUrl.trim(),
        model: model.trim(),
        // omitted = keep the stored key; "" = clear it
        api_key: clearKey ? '' : key.trim() !== '' ? key.trim() : undefined,
      },
      {
        onSuccess: () => {
          setKey('');
          setClearKey(false);
        },
      },
    );
  };

  const where = hosted ? '保存在服务器上本组的设置里，只用来转发本组的请求；组员和其他小组都看不到完整的 key，它也不进入项目文件和导出文件。' : '保存在本机 credentials.json（权限 0600），不进入项目目录和导出文件。';
  const keyHint = fromEnv
    ? '来自环境变量 STORYSCRIPT_LLM_API_KEY。'
    : view?.key_last4
      ? `只写不读：留空表示沿用已保存的 key。${where}`
      : `只写不读：${where}`;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      {fromEnv ? (
        <Notice tone="info" title="环境变量优先">
          当前配置来自环境变量 <span className="font-mono text-xs">STORYSCRIPT_LLM_*</span>，这里只读。要修改，请改环境变量后重启 storyscript-mov。
        </Notice>
      ) : null}

      <Field
        label="地址（base_url）"
        error={errors.base_url}
        hint="OpenAI 兼容接口的地址。下面是常用服务，兼容性以实测为准。"
      >
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={baseUrl}
            readOnly={fromEnv}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com"
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            className="font-mono text-xs read-only:text-graphite-300"
          />
        )}
      </Field>
      <ul aria-label="常用服务" className="-mt-1 flex flex-wrap gap-1">
        {presets.map((p) => (
          <li key={p.base_url}>
            <button
              type="button"
              disabled={fromEnv}
              title={`${p.base_url} · ${p.note}（兼容性以实测为准）`}
              onClick={() => {
                setBaseUrl(p.base_url);
                if (errors.base_url) setErrors({ ...errors, base_url: undefined });
              }}
              className={
                'h-6 rounded-control border border-graphite-700 px-2 text-xs text-graphite-300 ' +
                'hover:enabled:border-graphite-500 hover:enabled:text-graphite-100 disabled:cursor-not-allowed disabled:opacity-50'
              }
            >
              {p.name}
            </button>
          </li>
        ))}
      </ul>
      <details className="text-xs text-graphite-300">
        <summary className="cursor-pointer select-none hover:text-graphite-100">各服务的地址与结构化输出能力</summary>
        <ul className="mt-1.5 space-y-1">
          {presets.map((p) => (
            <li key={p.base_url} className="flex flex-col">
              <span className="text-graphite-100">
                {p.name} <span className="text-graphite-300">· {p.note}</span>
              </span>
              <span className="font-mono break-all">{p.base_url}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5">以上为 2026-09 的调研结论，兼容性以实测为准。</p>
      </details>

      <Field label="模型" error={errors.model} hint="模型 ID，以服务商控制台里显示的为准。">
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={model}
            readOnly={fromEnv}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs read-only:text-graphite-300"
          />
        )}
      </Field>

      <Field label="API key" hint={keyHint}>
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            type="password"
            aria-describedby={describedBy}
            value={key}
            readOnly={fromEnv}
            disabled={clearKey}
            onChange={(e) => setKey(e.target.value)}
            placeholder={view?.key_last4 ? `已保存，末四位 ${view.key_last4}` : '未设置'}
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono text-xs disabled:opacity-50"
          />
        )}
      </Field>
      {!fromEnv && view?.key_last4 ? (
        <label className="-mt-1 inline-flex items-center gap-1.5 text-xs text-graphite-300">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} className="size-3.5 accent-graphite-100" />
          清除已保存的 key
        </label>
      ) : null}

      {save.isError ? <ErrorNotice error={save.error} context="provider" /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {fromEnv ? null : (
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty}>
            {save.isPending ? null : <Save aria-hidden className="size-3.5" />}
            保存
          </Button>
        )}
        <Button
          onClick={() => test.mutate()}
          busy={test.isPending}
          disabled={view === null || dirty}
          title={view === null ? '先保存配置' : dirty ? '测试使用已保存的配置，请先保存' : '请求 {base_url}/models，不调用模型'}
        >
          {test.isPending ? null : <PlugZap aria-hidden className="size-3.5" />}
          测试连接
        </Button>
        <span aria-live="polite" className="text-xs text-graphite-300">
          {save.isSuccess && !dirty ? '已保存。' : dirty && view !== null ? '测试使用已保存的配置，请先保存。' : ''}
        </span>
      </div>

      {test.isError ? <ErrorNotice error={test.error} context="provider" /> : null}
      {test.data ? <TestResult result={test.data} /> : null}
    </form>
  );
}

/** Inspector groups for the text model: state, the form, and what leaves the machine. */
export function TextProviderPanel() {
  const providers = useProviders();
  const health = useHealth();
  const save = useSaveTextProvider();
  const test = useTestTextProvider();
  const view = providers.data?.text ?? null;
  const configured = health.data?.text_provider_configured ?? false;
  const demo = health.data?.demo ?? false;
  const host = hostOf(view?.base_url);

  return (
    <>
      <InspectorGroup
        title="文本模型"
        note={
          <p className="text-graphite-300">
            拆镜和实体抽取使用 OpenAI 兼容的 chat completions 接口。未配置时这些按钮置灰，手工流程照常可用。
            {demo ? ' 当前是演示模式：AI 按钮回放录制的样例输出，不会外发。' : ''}
          </p>
        }
      >
        <InspectorRow label="状态">
          <Dot ok={configured}>{configured ? '已配置' : '未配置'}</Dot>
        </InspectorRow>
        <InspectorRow label="来源">{view ? SETTING_SOURCE_LABEL[view.source] : <span className="text-graphite-300">无</span>}</InspectorRow>
        <InspectorRow label="API key">
          {view?.key_last4 ? (
            <span className="font-mono text-xs">
              <span aria-hidden>••••</span>
              {view.key_last4}
              <span className="sr-only">（末四位）</span>
            </span>
          ) : (
            <span className="text-graphite-300">未设置</span>
          )}
        </InspectorRow>
      </InspectorGroup>

      <InspectorGroup
        title="连接设置"
        note={
          providers.isPending ? (
            <Spinner label="正在读取配置…" />
          ) : providers.isError ? (
            <ErrorNotice error={providers.error} />
          ) : (
            <ProviderForm key={view ? `${view.source}|${view.base_url}|${view.model}|${view.key_last4 ?? ''}` : 'none'} view={view} save={save} test={test} />
          )
        }
      />

      <InspectorGroup
        title="外发说明"
        note={
          <p className="text-graphite-300">
            只有在你点击 AI 按钮时，才会把相关剧本段落发送到你配置的地址
            {host ? (
              <>
                （当前为 <span className="font-mono text-xs text-graphite-100">{host}</span>）
              </>
            ) : null}
            。每一步最多外发 3 次，网络重试、限流和校验失败都计入；已发出的请求可能计费，不会自动重发。
          </p>
        }
      />
    </>
  );
}
