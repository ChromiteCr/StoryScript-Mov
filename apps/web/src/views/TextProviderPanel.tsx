import { useState, type FormEvent } from 'react';
import type { ProviderTestResult, TextProviderView } from '@storyscript/contracts';
import { KeyRound, PlugZap, Save } from 'lucide-react';
import { useHealth, useProviders, useSaveTextProvider, useTestTextProvider } from '../lib/queries.ts';
import { SETTING_SOURCE_LABEL } from '../lib/labels.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Button, Field, Note, SectionHeading, Spinner, Tag, TextInput } from '../components/ui.tsx';

/**
 * Settings → 文本模型 (FR-03 BYOK, SPEC §6: the key is write-only here; the
 * page only ever sees key_last4 and where the setting comes from).
 */

interface Preset {
  name: string;
  base_url: string;
  note: string;
}

/** Common OpenAI-compatible endpoints (docs/research.md §2). Compatibility is not guaranteed. */
const PRESETS: readonly Preset[] = [
  { name: 'DeepSeek', base_url: 'https://api.deepseek.com', note: 'json_object 模式' },
  { name: '通义（兼容模式）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', note: '部分型号支持 json_schema；思考模式下可能失效' },
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

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

function TestResult({ result }: { result: ProviderTestResult }) {
  return (
    <div role="status" className={`rounded-sheet border px-3 py-2.5 text-[13px] ${result.ok ? 'border-ok/40 bg-ok-bg' : 'border-danger-rule bg-danger-bg'}`}>
      <p className={`font-medium ${result.ok ? 'text-ok' : 'text-danger'}`}>{result.ok ? '连接正常' : '连接未通过'}</p>
      <ul className="mt-1 space-y-0.5 text-ink-2">
        <li>模型列表接口：{result.models_endpoint ? '可以访问' : '无法访问'}</li>
        <li>
          配置的模型：
          {result.model_listed === null ? '服务没有提供模型列表，无法核对' : result.model_listed ? '在列表中找到' : '不在列表中，请核对模型名'}
        </li>
        {result.message ? <li className="break-words">说明：{result.message}</li> : null}
      </ul>
      <p className="mt-1.5 text-xs text-ink-3">这项检查只请求模型列表，不消耗 token。结构化输出的兼容性要在第一次拆镜时才能确认。</p>
    </div>
  );
}

interface ProviderFormProps {
  view: TextProviderView | null;
  /** owned by the panel so their state survives the form remount after a save */
  save: ReturnType<typeof useSaveTextProvider>;
  test: ReturnType<typeof useTestTextProvider>;
}

function ProviderForm({ view, save, test }: ProviderFormProps) {
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

  const host = hostOf(view?.base_url ?? '');

  return (
    <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
      {fromEnv ? (
        <Note tone="warn">
          <span className="font-medium text-warn">环境变量优先。</span>当前配置来自环境变量 <span className="font-mono text-[12.5px]">STORYSCRIPT_LLM_*</span>
          ，这里只读。要修改，请改环境变量后重启 storyscript-mov。
        </Note>
      ) : null}

      <Field
        label="base_url"
        error={errors.base_url}
        hint={
          <>
            OpenAI 兼容接口的地址。常用服务（兼容性以实测为准）：
            <span className="mt-1 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.base_url}
                  type="button"
                  disabled={fromEnv}
                  title={`${p.base_url} · ${p.note}`}
                  onClick={() => {
                    setBaseUrl(p.base_url);
                    if (errors.base_url) setErrors({ ...errors, base_url: undefined });
                  }}
                  className="rounded-control border border-rule bg-sheet px-1.5 text-xs leading-5 text-ink-2 hover:enabled:border-rule-strong hover:enabled:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {p.name}
                </button>
              ))}
            </span>
          </>
        }
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
            className="font-mono text-[13px] read-only:bg-sheet-sunk read-only:text-ink-2"
          />
        )}
      </Field>

      <details className="-mt-2 text-xs text-ink-3">
        <summary className="cursor-pointer select-none hover:text-ink-2">各服务的结构化输出能力</summary>
        <ul className="mt-1.5 space-y-1">
          {PRESETS.map((p) => (
            <li key={p.base_url} className="flex flex-col sm:flex-row sm:gap-2">
              <span className="shrink-0 text-ink-2 sm:w-28">{p.name}</span>
              <span className="font-mono break-all">{p.base_url}</span>
              <span className="sm:ml-auto sm:text-right">{p.note}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5">以上为 2026-09 的调研结论，兼容性以实测为准。</p>
      </details>

      <Field label="模型" error={errors.model} hint="模型 ID 由你填写，例如服务商控制台里显示的名字。">
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
            className="font-mono text-[13px] read-only:bg-sheet-sunk read-only:text-ink-2"
          />
        )}
      </Field>

      <Field
        label="API key"
        hint={
          fromEnv
            ? '来自环境变量 STORYSCRIPT_LLM_API_KEY。'
            : view?.key_last4
              ? '只写不读：留空表示沿用已保存的 key。保存在本机 credentials.json（权限 0600），不会进入项目目录或导出文件。'
              : '只写不读：保存在本机 credentials.json（权限 0600），不会进入项目目录或导出文件。'
        }
      >
        {({ id, describedBy }) => (
          <div className="flex flex-col gap-1.5">
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
              className="font-mono text-[13px] read-only:bg-sheet-sunk disabled:opacity-60"
            />
            {!fromEnv && view?.key_last4 ? (
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} className="size-3.5 accent-graphite" />
                清除已保存的 key
              </label>
            ) : null}
          </div>
        )}
      </Field>

      {save.isError ? <ErrorNotice error={save.error} context="provider" /> : null}
      {save.isSuccess && !dirty ? <p className="text-[13px] text-ok">已保存。</p> : null}

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
          title={view === null ? '先保存配置' : dirty ? '测试使用已保存的配置，请先保存' : undefined}
        >
          {test.isPending ? null : <PlugZap aria-hidden className="size-3.5" />}
          测试连接
        </Button>
        {dirty && view !== null ? <span className="text-xs text-ink-3">测试使用已保存的配置，请先保存。</span> : null}
      </div>

      {test.isError ? <ErrorNotice error={test.error} context="provider" /> : null}
      {test.data ? <TestResult result={test.data} /> : null}

      <p className="border-t border-rule pt-3 text-[13px] text-ink-2">
        只有在你点击 AI 按钮时，才会把相关剧本段落发送到你配置的地址{host ? <>（当前为 <span className="font-mono text-[12.5px]">{host}</span>）</> : null}。
        每一步最多外发 3 次，失败的请求也计入。
      </p>
    </form>
  );
}

export function TextProviderPanel() {
  const providers = useProviders();
  const health = useHealth();
  const save = useSaveTextProvider();
  const test = useTestTextProvider();
  const view = providers.data?.text ?? null;
  const configured = health.data?.text_provider_configured ?? false;

  return (
    <section className="rounded-sheet border border-rule bg-sheet px-5 py-4 sm:px-6">
      <SectionHeading
        title="文本模型"
        description="拆镜、实体抽取和排序建议使用 OpenAI 兼容的 chat completions 接口。未配置时这些按钮置灰，手工流程照常可用。"
        actions={
          <span className="flex items-center gap-1.5">
            {view ? (
              <Tag tone="neutral" title="配置来源">
                <KeyRound aria-hidden className="size-3" />
                {SETTING_SOURCE_LABEL[view.source]}
                {view.key_last4 ? ` · 末四位 ${view.key_last4}` : ''}
              </Tag>
            ) : null}
            <Tag tone={configured ? 'ok' : 'warn'}>{configured ? '已配置' : '未配置'}</Tag>
          </span>
        }
      />
      {providers.isPending ? (
        <div className="mt-4">
          <Spinner label="正在读取配置…" />
        </div>
      ) : providers.isError ? (
        <ErrorNotice className="mt-4" error={providers.error} />
      ) : (
        <ProviderForm key={view ? `${view.source}|${view.base_url}|${view.model}|${view.key_last4 ?? ''}` : 'none'} view={view} save={save} test={test} />
      )}
    </section>
  );
}
