import { useState, type FormEvent, type ReactNode } from 'react';
import type { ImageProviderView, ProviderTestResult } from '@storyscript/contracts';
import { BadgeDollarSign, PlugZap, Save } from 'lucide-react';
import { SETTING_SOURCE_LABEL } from '../../lib/labels.ts';
import {
  COST_NOTE,
  DIALECT_CHOICES,
  DIALECT_HINT,
  dialectChoiceOf,
  dialectOverrideOf,
  dialectText,
  hostOf,
  IMAGE_PROVIDER_PRESETS,
  NOT_SENT_DATA,
  SENT_DATA,
  validHttpUrl,
  verifiedText,
  type DialectChoice,
} from '../../lib/labels-raster.ts';
import { useHealth, useProviders } from '../../lib/queries.ts';
import { useSaveImageProvider, useTestImageProvider } from '../../lib/queries-raster.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Notice, SelectInput, Spinner, Tag, TextInput } from '../../components/ui.tsx';
import { InspectorGroup, InspectorRow } from '../../components/workspace.tsx';

/**
 * Settings → 模型 → 图像模型 (FR-12, experimental; SPEC §6). Three fields like
 * the text model (base_url, model, key) plus the request dialect: detected
 * from the host name, or forced. The key is write-only: the page only sees
 * its last 4 characters and where the setting comes from. The detection
 * result (dialect, preset, verified) and the server's host warning are shown
 * as they are; every combination is "未验证" until tested with a real key.
 *
 * Connection test in two tiers: a free check (GET /models) and a paid trial
 * (one smallest image) behind a confirmation.
 */

function Dot({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-warn'}`} />
      <span>{children}</span>
    </span>
  );
}

function TestResult({ result, paid }: { result: ProviderTestResult; paid: boolean }) {
  return (
    <Notice tone={result.ok ? 'info' : 'warn'} role="status" title={paid ? (result.ok ? '付费试生成成功' : '付费试生成未通过') : result.ok ? '免费检查通过' : '免费检查未通过'}>
      <ul className="space-y-0.5">
        {paid ? null : (
          <>
            <li>模型列表接口：{result.models_endpoint ? '可以访问' : '无法访问'}</li>
            <li>
              配置的模型：
              {result.model_listed === null ? '服务没有提供模型列表，无法核对' : result.model_listed ? '在列表中找到' : '不在列表中，请核对模型名'}
            </li>
          </>
        )}
        {result.message ? <li className="break-words">说明：{result.message}</li> : null}
      </ul>
      <p className="mt-1.5 text-xs">
        {paid ? '这次测试生成了 1 张最小尺寸的图片，结果不保存。' + COST_NOTE + '。' : '免费检查只请求模型列表，不生成图片；能否出图要做一次付费试生成或第一次重绘才能确认。'}
      </p>
    </Notice>
  );
}

interface FormProps {
  view: ImageProviderView | null;
  save: ReturnType<typeof useSaveImageProvider>;
  test: ReturnType<typeof useTestImageProvider>;
  onPaidTest: () => void;
}

function ImageProviderForm({ view, save, test, onPaidTest }: FormProps) {
  const fromEnv = view?.source === 'env';
  const [baseUrl, setBaseUrl] = useState(view?.base_url ?? '');
  const [model, setModel] = useState(view?.model ?? '');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [dialect, setDialect] = useState<DialectChoice>(dialectChoiceOf(view));
  const [errors, setErrors] = useState<{ base_url?: string; model?: string }>({});

  const dirty =
    baseUrl.trim() !== (view?.base_url ?? '') ||
    model.trim() !== (view?.model ?? '') ||
    key !== '' ||
    clearKey ||
    dialect !== dialectChoiceOf(view);
  const hasKey = Boolean(view?.key_last4);
  const testable = view !== null && hasKey && view.base_url !== '' && view.model !== '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!validHttpUrl(baseUrl)) next.base_url = '请填写完整的 http(s) 地址，例如 https://api.openai.com/v1';
    if (model.trim() === '') next.model = '请填写模型名';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    test.reset();
    save.mutate(
      {
        base_url: baseUrl.trim(),
        model: model.trim(),
        // omitted = keep the stored key; "" = clear it (environment values still win)
        api_key: fromEnv ? undefined : clearKey ? '' : key.trim() !== '' ? key.trim() : undefined,
        dialect_override: dialectOverrideOf(dialect),
      },
      {
        onSuccess: () => {
          setKey('');
          setClearKey(false);
        },
      },
    );
  };

  const keyHint = fromEnv
    ? '来自环境变量 STORYSCRIPT_IMAGE_API_KEY。'
    : hasKey
      ? '只写不读：留空表示沿用已保存的 key。保存在本机 credentials.json（权限 0600），不进入项目目录、日志和导出文件。'
      : '只写不读：保存在本机 credentials.json（权限 0600），不进入项目目录、日志和导出文件。';

  const testTitle = !testable ? '先保存地址、模型和 key' : dirty ? '测试使用已保存的配置，请先保存' : undefined;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      {fromEnv ? (
        <Notice tone="info" title="环境变量优先">
          地址、模型和 key 来自环境变量 <span className="font-mono text-xs">STORYSCRIPT_IMAGE_*</span>，这里只读；要修改请改环境变量后重启 storyscript-mov。写法可以在这里改。
        </Notice>
      ) : null}

      <Field label="地址（base_url）" error={errors.base_url} hint="图像服务的地址。按主机名自动识别写法；下面是常用服务，均未用真实 key 验证。">
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={baseUrl}
            readOnly={fromEnv}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            className="font-mono text-xs read-only:text-graphite-300"
          />
        )}
      </Field>
      <ul aria-label="常用图像服务" className="-mt-1 flex flex-wrap gap-1">
        {IMAGE_PROVIDER_PRESETS.map((p) => (
          <li key={p.base_url}>
            <button
              type="button"
              disabled={fromEnv}
              title={`${p.base_url} · ${p.note}`}
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
      {!fromEnv && hasKey ? (
        <label className="-mt-1 inline-flex items-center gap-1.5 text-xs text-graphite-300">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} className="size-3.5 accent-graphite-100" />
          清除已保存的 key
        </label>
      ) : null}

      <Field label="写法" hint={dialect === 'auto' ? '按主机名识别：火山方舟、OpenRouter 用 generations-ref，其余默认 openai-edits。' : DIALECT_HINT[dialect]}>
        {({ id, describedBy }) => (
          <SelectInput id={id} aria-describedby={describedBy} value={dialect} onChange={(e) => setDialect(e.target.value as DialectChoice)}>
            {DIALECT_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SelectInput>
        )}
      </Field>

      {save.isError ? <ErrorNotice error={save.error} context="provider" /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty}>
          {save.isPending ? null : <Save aria-hidden className="size-3.5" />}
          保存
        </Button>
        <Button
          onClick={() => test.mutate(false)}
          busy={test.isPending && test.variables === false}
          disabled={!testable || dirty || test.isPending}
          title={testTitle ?? '请求 {base_url}/models，不生成图片，不计费'}
        >
          {test.isPending && test.variables === false ? null : <PlugZap aria-hidden className="size-3.5" />}
          免费检查
        </Button>
        <Button
          onClick={onPaidTest}
          busy={test.isPending && test.variables === true}
          disabled={!testable || dirty || test.isPending}
          title={testTitle ?? '生成 1 张最小尺寸图片（会计费，先确认）'}
        >
          {test.isPending && test.variables === true ? null : <BadgeDollarSign aria-hidden className="size-3.5" />}
          付费试生成…
        </Button>
        <span aria-live="polite" className="text-xs text-graphite-300">
          {save.isSuccess && !dirty ? '已保存。' : dirty && view !== null ? '测试使用已保存的配置，请先保存。' : ''}
        </span>
      </div>

      {test.isError ? <ErrorNotice error={test.error} context="provider" /> : null}
      {test.data ? <TestResult result={test.data} paid={test.variables === true} /> : null}
    </form>
  );
}

function PaidTestDialog({ view, onClose, onConfirm }: { view: ImageProviderView; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      title="付费试生成"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onConfirm}>
            确认生成
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <Notice tone="warn" title={`将生成 1 张最小尺寸图片，${COST_NOTE}`}>
          用一张简单的测试控制图（一个方框）请求一次，确认地址、key、模型和写法都能出图。结果不保存，也不会自动重试。
        </Notice>
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <dt className="text-xs leading-5 text-graphite-300">目标主机</dt>
          <dd className="font-mono text-xs leading-5 break-all text-graphite-100">{hostOf(view.base_url) ?? view.base_url}</dd>
          <dt className="text-xs leading-5 text-graphite-300">写法</dt>
          <dd className="leading-5 text-graphite-100">{dialectText(view)}</dd>
          <dt className="text-xs leading-5 text-graphite-300">模型</dt>
          <dd className="font-mono text-xs leading-5 break-all text-graphite-100">{view.model}</dd>
        </dl>
      </div>
    </Dialog>
  );
}

/** Inspector groups for the image model: detection result, the form, what leaves the machine. */
export function ImageProviderPanel() {
  const providers = useProviders();
  const health = useHealth();
  const save = useSaveImageProvider();
  const test = useTestImageProvider();
  const [paidAsk, setPaidAsk] = useState(false);
  const view = providers.data?.image ?? null;
  const configured = health.data?.image_provider_configured ?? false;
  const demo = health.data?.demo ?? false;
  const host = hostOf(view?.base_url);

  return (
    <>
      <InspectorGroup
        title="图像模型（实验）"
        note={
          <p className="text-graphite-300">
            只有 AI 铅笔重绘用到图像模型；结构线稿和铅笔稿由本机渲染，不需要它。未配置时分镜页的重绘按钮置灰。
            {demo ? ' 当前是演示模式：不提供 AI 重绘，也不会外发。' : ''}
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
        {view ? (
          <>
            <InspectorRow label="识别的写法">
              <span data-image-dialect={view.dialect}>{dialectText(view)}</span>
              <span className="block text-xs text-graphite-300">{view.dialect_override ? '（手动指定）' : '（按主机名自动识别）'}</span>
            </InspectorRow>
            <InspectorRow label="验证状态">
              {view.verified ? (
                <Tag tone="ok">{verifiedText(view)}</Tag>
              ) : (
                <span className="flex flex-col items-start gap-1">
                  <Tag tone="warn">未验证</Tag>
                  <span className="text-xs text-graphite-300">这个组合还没有用真实 key 跑通过：请求格式按服务商文档对照假服务开发，出图效果和计费以实测为准。</span>
                </span>
              )}
            </InspectorRow>
          </>
        ) : null}
      </InspectorGroup>

      {view?.warning ? (
        <div className="px-3 py-3">
          <Notice tone="warn" title="这个地址可能不能用于草图重绘" role="status">
            {view.warning}
          </Notice>
        </div>
      ) : null}

      <InspectorGroup
        title="图像模型 · 连接设置"
        note={
          providers.isPending ? (
            <Spinner label="正在读取配置…" />
          ) : providers.isError ? (
            <ErrorNotice error={providers.error} />
          ) : (
            <ImageProviderForm
              key={view ? `${view.source}|${view.base_url}|${view.model}|${view.key_last4 ?? ''}|${view.dialect_override ?? ''}` : 'none'}
              view={view}
              save={save}
              test={test}
              onPaidTest={() => setPaidAsk(true)}
            />
          )
        }
      />

      <InspectorGroup
        title="图像模型 · 外发与标识"
        note={
          <div className="flex flex-col gap-2 text-graphite-300">
            <p>
              只有在分镜页点"AI 铅笔重绘"并确认后，才会把{SENT_DATA}发送到你配置的地址
              {host ? (
                <>
                  （当前为 <span className="font-mono text-xs text-graphite-100">{host}</span>）
                </>
              ) : null}
              。不发送{NOT_SENT_DATA}。
            </p>
            <p>
              每次只生成 1 张候选图，{COST_NOTE}；本工具只记录服务返回的用量，拿不到时显示"用量未知"。请求发出后超时或断开时结果未知，为避免重复计费不会自动重发。
            </p>
            <p>
              AI 生成内容标识：候选图和它的说明文件保存在项目目录里，记录为"模型生成"（含模型、主机、提示词和时间）；采用后分镜大图左上角常驻"AI 生成"角标，打印和单格 PNG 默认也带这个角标。AI 图永远不会改写分镜结构和镜头字段。
            </p>
          </div>
        }
      />

      {paidAsk && view ? (
        <PaidTestDialog
          view={view}
          onClose={() => setPaidAsk(false)}
          onConfirm={() => {
            setPaidAsk(false);
            test.mutate(true);
          }}
        />
      ) : null}
    </>
  );
}
