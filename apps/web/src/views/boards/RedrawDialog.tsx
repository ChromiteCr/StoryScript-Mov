import { useId, useMemo, useState, type ReactNode } from 'react';
import type { BoardView, ImageProviderView, ShotFields } from '@storyscript/contracts';
import { Send } from 'lucide-react';
import {
  COST_NOTE,
  DIALECT_HINT,
  DIALECT_LABEL,
  NOT_SENT_DATA,
  QUALITIES,
  QUALITY_LABEL,
  redrawPreview,
  type RedrawQuality,
} from '../../lib/labels-raster.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Tag } from '../../components/ui.tsx';
import { boardUrl } from './images.ts';
import { useEntities } from '../../lib/queries.ts';

/**
 * Confirmation before an AI redraw (SPEC FR-11/FR-12): where the request
 * goes (host, dialect, model), what is sent (the control image, a summary of
 * the prompt, the words filtered out of the shot text), the quality tier and
 * "费用以服务商账单为准". Nothing leaves the machine until "确认发送".
 */

export interface RedrawDialogProps {
  board: BoardView;
  fields: ShotFields | undefined;
  provider: ImageProviderView;
  busy: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: (quality: RedrawQuality) => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs leading-5 text-graphite-300">{label}</dt>
      <dd className="min-w-0 text-sm leading-5 break-words text-graphite-100">{children}</dd>
    </>
  );
}

export function RedrawDialog({ board, fields, provider, busy, error, onClose, onConfirm }: RedrawDialogProps) {
  const [quality, setQuality] = useState<RedrawQuality>('low');
  const entities = useEntities().data;
  const preview = useMemo(() => redrawPreview(board.spec, fields, provider, entities), [board.spec, fields, provider, entities]);
  const controlUrl = useMemo(() => boardUrl({ spec: board.spec, mode: 'pencil', overlay: false, code: null }), [board.spec]);
  const qualityId = useId();

  return (
    <Dialog
      title={`AI 铅笔重绘（实验）· 镜 ${board.shot_code}`}
      description="生成 1 张候选图，由你对照后决定是否采用。不会改动分镜结构和镜头字段。"
      onClose={onClose}
      busy={busy}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-graphite-300">{COST_NOTE}</span>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" busy={busy} onClick={() => onConfirm(quality)}>
            {busy ? null : <Send aria-hidden className="size-3.5" />}
            确认发送
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <section aria-label="发送到">
          <h3 className="mb-1.5 text-xs font-medium text-graphite-100">发送到</h3>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <Row label="目标主机">
              <span className="font-mono text-xs" data-redraw-host="">
                {preview.host}
              </span>
            </Row>
            <Row label="写法">
              <span className="flex flex-wrap items-center gap-1.5">
                <span title={DIALECT_HINT[preview.dialect]}>{DIALECT_LABEL[preview.dialect]}</span>
                {preview.preset ? <span className="text-graphite-300">· {preview.preset}</span> : null}
                {preview.verified ? <Tag tone="ok">已验证</Tag> : <Tag tone="warn">未验证</Tag>}
              </span>
            </Row>
            <Row label="模型">
              <span className="font-mono text-xs">{preview.model}</span>
            </Row>
          </dl>
          {preview.warning ? (
            <Notice tone="warn" title="这个地址可能不能用于草图重绘" className="mt-2">
              {preview.warning}
            </Notice>
          ) : null}
        </section>

        <section aria-label="将发送的内容">
          <h3 className="mb-1.5 text-xs font-medium text-graphite-100">将发送的内容</h3>
          <figure className="flex flex-col gap-1">
            <div data-paper="" className="overflow-hidden rounded-paper bg-paper p-1 [color-scheme:light]">
              <img src={controlUrl} alt="控制图预览：不含文字、镜号和箭头" data-control-preview="" className="block h-auto w-full" />
            </div>
            <figcaption className="text-xs text-graphite-300">控制图：由同一份分镜渲染，不含文字、镜号和箭头（服务端按服务要求的比例补白边）。</figcaption>
          </figure>
          <div className="mt-2">
            <p className="text-xs text-graphite-300">提示词摘要（默认英文；角色名已替换为 Person 1、Person 2…）</p>
            <ul aria-label="提示词摘要" className="mt-1 flex flex-col gap-0.5 rounded-control border border-graphite-700 bg-graphite-950 px-2 py-1.5 font-mono text-xs leading-5 break-words text-graphite-100">
              {preview.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-graphite-300">被过滤掉的词：</span>
            {preview.prompt.removed.length ? (
              <ul aria-label="被过滤掉的词" className="flex flex-wrap gap-1">
                {preview.prompt.removed.map((w) => (
                  <li key={w} className="rounded-control border border-graphite-700 px-1.5 leading-5 text-graphite-100 line-through decoration-graphite-300">
                    {w}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-graphite-100">无</span>
            )}
          </div>
          <p className="mt-2 text-xs text-graphite-300">不发送：{NOT_SENT_DATA}。</p>
          <details className="mt-1.5 text-xs text-graphite-300">
            <summary className="cursor-pointer select-none hover:text-graphite-100">完整提示词（预览）</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-control border border-graphite-700 bg-graphite-950 px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap text-graphite-100">
              {preview.prompt.text}
            </pre>
            <p className="mt-1">服务端会从已保存的分镜重新编译同一份提示词；按服务的尺寸要求，可能多一句"画格外留白"。</p>
          </details>
        </section>

        <section aria-labelledby={qualityId}>
          <h3 id={qualityId} className="mb-1.5 text-xs font-medium text-graphite-100">
            质量档位
          </h3>
          <div role="radiogroup" aria-labelledby={qualityId} className="flex flex-wrap gap-1">
            {QUALITIES.map((q) => (
              <button
                key={q}
                type="button"
                role="radio"
                aria-checked={quality === q}
                disabled={!preview.sendsQuality && q !== 'low'}
                onClick={() => setQuality(q)}
                className={
                  'h-6 rounded-control border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ' +
                  (quality === q ? 'border-graphite-300 bg-graphite-700 font-medium text-graphite-100' : 'border-graphite-700 text-graphite-300 hover:enabled:text-graphite-100')
                }
              >
                {QUALITY_LABEL[q]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-graphite-300">
            {preview.sendsQuality ? '档位越高越贵，也越慢；草图用"低"通常就够。' : '这个写法没有质量参数，档位不会发送。'}
          </p>
        </section>

        <Notice tone="warn" title={COST_NOTE}>
          一次只生成 1 张。本工具只记录服务返回的用量，不估算金额；请求发出后如果超时，结果未知，为避免重复计费不会自动重发。
        </Notice>
        {error ? <ErrorNotice error={error} context="provider" /> : null}
      </div>
    </Dialog>
  );
}
