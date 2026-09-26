import { useId, type ReactNode } from 'react';
import type { Job } from '@storyscript/contracts';
import { Check, Layers, X } from 'lucide-react';
import {
  adoptBlockedReason,
  AI_VIEW_LABEL,
  AI_VIEW_MODES,
  RASTER_OUTCOME_LABEL,
  RASTER_STATUS_LABEL,
  rasterStaleFor,
  rasterTime,
  rasterUsageText,
  redrawJobView,
  STALE_DETAIL,
  STALE_TITLE,
  type ShotRaster,
} from '../../lib/labels-raster.ts';
import { pageHref } from '../../lib/stages.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Spinner, Tag } from '../../components/ui.tsx';
import type { RasterWorkbench } from './useRasters.ts';
import type { BoardSpec } from '@storyscript/contracts';

/**
 * The board page's AI raster UI (FR-12, experimental):
 *  - AiBar: over the frame while a raster is shown — view mode (AI 图 + 标注 /
 *    叠加对比 / 只看 AI 图 / 只看线稿), onion opacity 0–100 %, adopt / reject
 *    the compared candidate, and the stale warning;
 *  - RedrawJobNotice: the followed redraw job (queued, running, failed, result
 *    unknown — never re-sent automatically);
 *  - RasterList: every raster of the shot's board versions with status,
 *    outcome, model, time, usage ("用量未知") and stale marks.
 */

export interface RasterActions {
  onAdopt: (r: ShotRaster) => void;
  onReject: (r: ShotRaster) => void;
  adopting: string | null;
  rejecting: string | null;
  error: unknown;
}

// ------------------------------------------------------------------ AiBar

export function AiBar({ ai, actions }: { ai: RasterWorkbench; actions: RasterActions }) {
  const sliderId = useId();
  const r = ai.shown;
  if (!r) return null;
  const compared = ai.compared;
  const adoptBlocked = compared ? adoptBlockedReason(compared) : null;
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label="AI 图层" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-graphite-700 bg-graphite-800 px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-xs text-graphite-100">
          <Layers aria-hidden className="size-3.5 text-graphite-300" />
          {compared ? (compared.status === 'adopted' ? '已采用的 AI 图' : '对比候选') : '已采用的 AI 图'}
          <span className="text-graphite-300 tabular-nums">{rasterTime(r.created_at)}</span>
        </span>
        <div role="radiogroup" aria-label="AI 图显示方式" className="flex items-center gap-0.5 rounded-control bg-graphite-900 p-0.5">
          {AI_VIEW_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={ai.mode === m}
              onClick={() => ai.setMode(m)}
              className={
                'h-6 rounded-control px-2 text-xs whitespace-nowrap ' +
                (ai.mode === m ? 'bg-graphite-700 font-medium text-graphite-100' : 'text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100')
              }
            >
              {AI_VIEW_LABEL[m]}
            </button>
          ))}
        </div>
        {ai.mode === 'onion' ? (
          <span className="flex min-w-[180px] flex-1 items-center gap-2">
            <label htmlFor={sliderId} className="shrink-0 text-xs text-graphite-300">
              AI 图不透明度
            </label>
            <input
              id={sliderId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={ai.opacity}
              onChange={(e) => ai.setOpacity(Number(e.target.value))}
              className="h-5 min-w-0 flex-1 accent-graphite-100"
            />
            <output htmlFor={sliderId} className="w-10 shrink-0 text-right text-xs text-graphite-100 tabular-nums">
              {ai.opacity}%
            </output>
          </span>
        ) : null}
        {compared ? (
          <span className="ml-auto flex items-center gap-1">
            {compared.status !== 'adopted' ? (
              <Button
                size="sm"
                variant="primary"
                disabled={adoptBlocked !== null}
                title={adoptBlocked ?? '采用这张图：大图和导出使用它 + 矢量标注层'}
                busy={actions.adopting === compared.id}
                onClick={() => actions.onAdopt(compared)}
              >
                <Check aria-hidden className="size-3.5" />
                采用
              </Button>
            ) : null}
            {compared.status !== 'rejected' ? (
              <Button size="sm" busy={actions.rejecting === compared.id} onClick={() => actions.onReject(compared)}>
                拒绝
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => ai.compare(null)}>
              <X aria-hidden className="size-3.5" />
              退出对比
            </Button>
          </span>
        ) : null}
      </div>
      {ai.stale && ai.mode !== 'lines' ? (
        <Notice tone="warn" title={STALE_TITLE} role="status">
          {STALE_DETAIL}
        </Notice>
      ) : null}
      {actions.error ? <ErrorNotice error={actions.error} /> : null}
    </div>
  );
}

// ------------------------------------------------------ RedrawJobNotice

export function RedrawJobNotice({ job, onCancel, cancelling }: { job: Job; onCancel: () => void; cancelling: boolean }) {
  const v = redrawJobView(job);
  if (v.busy) {
    return (
      <div role="status" data-redraw-job={job.status} className="flex flex-wrap items-center gap-2 rounded-panel border border-graphite-700 bg-graphite-800 px-3 py-2">
        <Spinner label={v.title} />
        {v.detail ? <span className="text-xs text-graphite-300">{v.detail}</span> : null}
        <Button size="sm" variant="ghost" className="ml-auto" busy={cancelling} onClick={onCancel} title="请求已经发出时取消，结果会标为未知，服务仍可能计费">
          取消
        </Button>
      </div>
    );
  }
  const tone = v.tone === 'ok' ? 'info' : v.tone;
  return (
    <div data-redraw-job={job.status}>
      <Notice tone={tone} title={v.title} role={v.tone === 'danger' ? 'alert' : 'status'}>
        {v.detail}
      </Notice>
    </div>
  );
}

// ------------------------------------------------------------ RasterList

function Thumb({ r }: { r: ShotRaster }) {
  if (!r.image_url) {
    return (
      <span className="flex aspect-[2.39/1] w-full items-center justify-center rounded-control border border-dashed border-graphite-700 text-xs text-graphite-300">
        无图像
      </span>
    );
  }
  return (
    <span data-paper="" className="block overflow-hidden rounded-control bg-paper">
      <img src={r.image_url} alt="" loading="lazy" decoding="async" className="block h-auto w-full" />
    </span>
  );
}

function StatusTag({ r }: { r: ShotRaster }) {
  if (r.status === 'adopted') return <Tag tone="ok">{RASTER_STATUS_LABEL.adopted}</Tag>;
  return <Tag>{RASTER_STATUS_LABEL[r.status]}</Tag>;
}

export interface RasterListProps {
  ai: RasterWorkbench;
  actions: RasterActions;
  /** the frame being edited (stale check against unsaved edits) */
  spec: BoardSpec;
  /** redraw is not available: why (shown when the list is empty) */
  blocked: string | null;
  /** extra line under the title (e.g. the left-behind notice) */
  children?: ReactNode;
}

export function RasterList({ ai, actions, spec, blocked, children }: RasterListProps) {
  const titleId = useId();
  const list = ai.list;
  if (list.length === 0 && !ai.pending && !ai.error) {
    if (!blocked) return null;
    return (
      <p className="text-xs text-graphite-300" data-redraw-blocked="">
        AI 铅笔重绘（实验）暂不可用：{blocked}
        {blocked.includes('设置') ? (
          <>
            {' '}
            <a href={pageHref('settings')} className="text-graphite-100 underline decoration-graphite-500 underline-offset-2 hover:decoration-graphite-100">
              打开设置
            </a>
          </>
        ) : null}
      </p>
    );
  }
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 rounded-panel border border-graphite-800 bg-graphite-900 p-2">
      <h3 id={titleId} className="flex items-center justify-between gap-2 px-0.5 text-xs font-medium text-graphite-100">
        <span>AI 候选（实验）</span>
        <span className="font-normal text-graphite-300 tabular-nums">{list.length} 张</span>
      </h3>
      {children}
      {ai.error ? <ErrorNotice error={ai.error} /> : null}
      {ai.pending && list.length === 0 ? <Spinner label="正在读取候选图…" /> : null}
      <ul aria-label="AI 候选列表" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((r) => {
          const stale = rasterStaleFor(r, spec);
          const comparing = ai.compared?.id === r.id;
          const blockedAdopt = adoptBlockedReason(r);
          return (
            <li
              key={r.id}
              data-raster={r.id}
              data-status={r.status}
              data-stale={stale || undefined}
              className={
                'flex min-w-0 flex-col gap-1.5 rounded-panel border p-1.5 ' +
                (comparing ? 'border-accent bg-graphite-800' : 'border-graphite-800 bg-graphite-950/40')
              }
            >
              <button
                type="button"
                disabled={!r.image_url}
                aria-pressed={comparing}
                aria-label={`对比 ${rasterTime(r.created_at)} 的候选图（${RASTER_STATUS_LABEL[r.status]}${stale ? '，构图已改' : ''}）`}
                onClick={() => ai.compare(comparing ? null : r.id)}
                className="block w-full min-w-0 rounded-control text-left disabled:cursor-default"
              >
                <Thumb r={r} />
              </button>
              <div className="flex flex-wrap items-center gap-1">
                <StatusTag r={r} />
                {r.outcome !== 'ok' ? <Tag tone="warn">{RASTER_OUTCOME_LABEL[r.outcome]}</Tag> : null}
                {stale ? (
                  <Tag tone="warn" title={STALE_TITLE}>
                    构图已改
                  </Tag>
                ) : null}
                {!r.current ? <Tag title="属于这个镜头的旧分镜版本">v{r.board_version}</Tag> : null}
                {comparing ? <Tag>对比中</Tag> : null}
              </div>
              <dl className="grid grid-cols-[2.5em_minmax(0,1fr)] gap-x-1.5 text-xs leading-5">
                <dt className="text-graphite-300">模型</dt>
                <dd className="truncate font-mono text-graphite-100" title={`${r.model} @ ${r.host}`}>
                  {r.model}
                </dd>
                <dt className="text-graphite-300">时间</dt>
                <dd className="text-graphite-100 tabular-nums">{rasterTime(r.created_at)}</dd>
                <dt className="text-graphite-300">用量</dt>
                <dd className="truncate text-graphite-100">{rasterUsageText(r.usage)}</dd>
              </dl>
              <div className="flex flex-wrap gap-1">
                {r.image_url ? (
                  <Button size="sm" variant={comparing ? 'secondary' : 'ghost'} onClick={() => ai.compare(comparing ? null : r.id)}>
                    {comparing ? '退出对比' : '对比'}
                  </Button>
                ) : null}
                {r.status !== 'adopted' ? (
                  <Button
                    size="sm"
                    disabled={blockedAdopt !== null}
                    title={blockedAdopt ?? '采用：大图和导出使用这张图 + 矢量标注层'}
                    busy={actions.adopting === r.id}
                    onClick={() => actions.onAdopt(r)}
                  >
                    采用
                  </Button>
                ) : null}
                {r.status !== 'rejected' ? (
                  <Button size="sm" variant="ghost" busy={actions.rejecting === r.id} onClick={() => actions.onReject(r)}>
                    拒绝
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="px-0.5 text-xs text-graphite-300">候选图只作参考：采用后大图显示"AI 图 + 矢量标注层"，导出默认带"AI 生成"角标；分镜结构和镜头字段不会被改写。</p>
    </section>
  );
}
