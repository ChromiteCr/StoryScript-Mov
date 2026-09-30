import { useMemo, useState, type ReactNode } from 'react';
import type { Board, BoardView, Project, Shot } from '@storyscript/contracts';
import { Download, History, Redo2, RefreshCw, Save, Sparkles, Undo2 } from 'lucide-react';
import { boardCaption, pngFileName } from '../../lib/print-boards.ts';
import { RENDER_MODE_LABEL, versionLabel, type BoardViewMode } from '../../lib/labels-boards.ts';
import { actorShortText } from '../../lib/crew.ts';
import { isTerminalJob, untrackJob } from '../../lib/jobs.ts';
import { rasterStaleFor, redrawBlockedReason, STALE_TITLE, type ShotRaster } from '../../lib/labels-raster.ts';
import { useCancelJob, useHealth, useProviders } from '../../lib/queries.ts';
import { isRevisionConflict } from '../../lib/queries-boards.ts';
import { readAiLabelPref, redrawSlot, useAdoptRaster, useRejectRaster, useRequestRedraw } from '../../lib/queries-raster.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, IconButton, Notice, SelectInput, Tag } from '../../components/ui.tsx';
import { PaperCanvas, Panel, PanelToolbar } from '../../components/workspace.tsx';
import { BoardCanvas } from './BoardCanvas.tsx';
import { composeBoardPng, downloadBlob } from './exportPng.ts';
import { useBoardUrl } from './images.ts';
import { AiBar, RasterList, RedrawJobNotice, type RasterActions } from './RasterPanel.tsx';
import { RedrawDialog } from './RedrawDialog.tsx';
import type { EditorApi } from './useEditor.ts';
import { useRasterWorkbench } from './useRasters.ts';

/**
 * Main panel of the board page: toolbar (render mode, undo/redo, save as new
 * version, AI pencil redraw, version history, PNG), the stale banner, the
 * frame on paper with its editing handles (and, FR-12, an adopted or compared
 * AI raster), the shot's AI candidates, caption and the read-only topview.
 */

const MODES: BoardViewMode[] = ['pencil', 'structure'];

export interface BoardMainProps {
  project: Project;
  /** the shot's newest board as listed (carries adopted_raster_id) */
  board: BoardView;
  editor: EditorApi;
  shot: Shot | undefined;
  mode: BoardViewMode;
  onMode: (m: BoardViewMode) => void;
  versions: Board[] | undefined;
  /** null = the newest version (editable) */
  viewing: Board | null;
  onView: (id: string | null) => void;
  onSave: () => void;
  saving: boolean;
  saveError: unknown;
  onRegenerate: () => void;
  regenerating: boolean;
  onKeep: () => void;
  keeping: boolean;
  staleError: unknown;
}

function Topview({ spec }: { spec: BoardView['spec'] }) {
  const req = useMemo(() => ({ spec, mode: 'topview' as const, overlay: true, code: null }), [spec]);
  const url = useBoardUrl(req, false);
  return <img src={url} alt="俯视站位示意图（只读）" draggable={false} className="block h-auto w-full" />;
}

/** A small paper card (same tokens as PaperCanvas, tighter padding). */
function Paper({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} data-paper="" className="rounded-paper bg-paper p-3 text-ink [color-scheme:light]">
      {children}
    </div>
  );
}

function CaptionBlock({ board, shot }: { board: BoardView; shot: Shot | undefined }) {
  const c = boardCaption(board, shot);
  return (
    <dl className="grid grid-cols-[4.5em_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm text-ink">
      <dt className="text-ink/70">镜号</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <span className="font-medium tabular-nums">{c.code}</span>
        <span className="text-xs text-ink/70">{c.version}</span>
        {c.locked ? <span className="rounded-control border border-ink/40 px-1 text-xs text-ink/80">已锁定</span> : null}
      </dd>
      <dt className="text-ink/70">动作</dt>
      <dd className="break-words">{c.action}</dd>
      <dt className="text-ink/70">对白</dt>
      <dd className="break-words">{c.dialogue ? `「${c.dialogue}」` : '—'}</dd>
      <dt className="text-ink/70">镜头</dt>
      <dd>{c.grammar}</dd>
      <dt className="text-ink/70">时长</dt>
      <dd className="tabular-nums">{c.duration}</dd>
    </dl>
  );
}

export function BoardMain(p: BoardMainProps) {
  const { editor, shot, mode, viewing } = p;
  const latest = editor.base;
  const readOnly = viewing !== null;
  const spec = viewing ? viewing.spec : editor.spec;
  const shown: BoardView = viewing ? { ...latest, ...viewing, stale: latest.stale } : { ...latest, spec };
  const [pngBusy, setPngBusy] = useState(false);
  const [pngError, setPngError] = useState<unknown>(null);

  // ---- AI pencil redraw (FR-12, experimental)
  const health = useHealth();
  const providers = useProviders();
  const ai = useRasterWorkbench(p.board, p.versions, editor.present);
  const redraw = useRequestRedraw();
  const adopt = useAdoptRaster();
  const reject = useRejectRaster();
  const cancel = useCancelJob();
  const [confirming, setConfirming] = useState(false);
  const imageView = providers.data?.image ?? null;
  const demo = health.data?.demo ?? false;
  const configured = (health.data?.image_provider_configured ?? false) && imageView !== null;
  const setupBlocked = redrawBlockedReason({ demo, configured, dirty: false, viewingOld: false });
  const blocked = redrawBlockedReason({ demo, configured, dirty: editor.dirty, viewingOld: readOnly });
  const jobBusy = ai.job !== null && !isTerminalJob(ai.job);
  const recommended = shot?.fields.set_piece ?? false;
  const rasterActions: RasterActions = {
    onAdopt: (r: ShotRaster) => adopt.mutate(r.id, { onSuccess: () => ai.adoptedShown() }),
    onReject: (r: ShotRaster) =>
      reject.mutate(r.id, {
        onSuccess: () => {
          if (ai.compared?.id === r.id) ai.compare(null);
        },
      }),
    adopting: adopt.isPending ? (adopt.variables ?? null) : null,
    rejecting: reject.isPending ? (reject.variables ?? null) : null,
    error: adopt.error ?? reject.error,
  };
  const aiLayer =
    !readOnly && ai.shown?.image_url && ai.mode !== 'lines'
      ? { url: ai.shown.image_url, mode: ai.mode, opacity: ai.opacity / 100, badge: true, stale: ai.stale }
      : null;
  const pngRaster = !readOnly && ai.adopted?.image_url && !rasterStaleFor(ai.adopted, spec) ? ai.adopted.image_url : null;

  const exportPng = async () => {
    setPngBusy(true);
    setPngError(null);
    try {
      const blob = await composeBoardPng(spec, boardCaption(shown, shot), pngRaster ? { rasterUrl: pngRaster, label: readAiLabelPref(p.project.id) } : null);
      downloadBlob(blob, pngFileName(p.project.name, latest.shot_code, shown.version));
    } catch (e) {
      setPngError(e);
    } finally {
      setPngBusy(false);
    }
  };

  const tools = (
    <span className="text-xs text-graphite-300 tabular-nums">
      {viewing
        ? `只读 · ${versionLabel(viewing)}`
        : editor.dragging
          ? `拖动中显示${RENDER_MODE_LABEL.structure}，松手后出${RENDER_MODE_LABEL[mode]}`
          : editor.dirty
            ? '有未保存的修改'
            : versionLabel(latest)}
    </span>
  );

  return (
    <Panel title={`分镜稿 · 镜 ${latest.shot_code}`} tools={tools} padded={false}>
      <PanelToolbar label="分镜稿工具">
        <div role="radiogroup" aria-label="显示方式" className="flex items-center gap-0.5">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => p.onMode(m)}
              aria-label={RENDER_MODE_LABEL[m]}
              className={
                'h-6 rounded-control px-2 text-xs whitespace-nowrap ' +
                (mode === m ? 'bg-graphite-700 font-medium text-graphite-100' : 'text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100')
              }
            >
              <span className="sm:hidden">{m === 'pencil' ? '铅笔' : '结构'}</span>
              <span className="hidden sm:inline">{RENDER_MODE_LABEL[m]}</span>
            </button>
          ))}
        </div>
        <span aria-hidden className="mx-1 h-4 w-px bg-graphite-700" />
        <IconButton icon={Undo2} label={editor.undoLabel ? `撤销：${editor.undoLabel}（⌘Z）` : '撤销（⌘Z）'} disabled={readOnly || !editor.canUndo} onClick={editor.undo} />
        <IconButton icon={Redo2} label={editor.redoLabel ? `重做：${editor.redoLabel}（⇧⌘Z）` : '重做（⇧⌘Z）'} disabled={readOnly || !editor.canRedo} onClick={editor.redo} />
        <Button size="sm" variant={editor.dirty && !readOnly ? 'primary' : 'ghost'} disabled={readOnly || !editor.dirty} busy={p.saving} onClick={p.onSave} aria-label="保存为新版本">
          <Save aria-hidden className="size-3.5" />
          <span className="sm:hidden">保存</span>
          <span className="hidden sm:inline">保存为新版本</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={blocked !== null || jobBusy}
          title={blocked ?? (jobBusy ? '上一张还在生成' : '把这一格交给图像模型重画成铅笔稿（实验，可能计费；先确认再发送）')}
          onClick={() => setConfirming(true)}
          aria-label="AI 铅笔重绘（实验）"
        >
          <Sparkles aria-hidden className="size-3.5" />
          <span className="sm:hidden">AI</span>
          <span className="hidden sm:inline">AI 铅笔重绘（实验）</span>
        </Button>
        {recommended ? (
          <Tag title="大场面镜头：AI 重绘最能补足质感（仍需确认后才会发送）" className="hidden sm:inline-flex">
            推荐
          </Tag>
        ) : null}
        <span className="ml-auto flex min-w-0 items-center gap-1">
          <History aria-hidden className="hidden size-3.5 shrink-0 text-graphite-300 sm:block" />
          <SelectInput
            aria-label="版本历史"
            className="h-6 w-auto max-w-[92px] text-xs sm:max-w-[180px]"
            value={viewing?.id ?? ''}
            onChange={(e) => p.onView(e.target.value || null)}
            disabled={!p.versions}
          >
            <option value="">{`最新 · ${versionLabel(latest)}${latest.actor ? ` · ${actorShortText(latest.actor)}` : ''}`}</option>
            {(p.versions ?? [])
              .filter((v) => v.id !== latest.id)
              .slice()
              .reverse()
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v)}
                  {v.actor ? ` · ${actorShortText(v.actor)}` : ''} · {new Date(v.created_at).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}
                </option>
              ))}
          </SelectInput>
          <IconButton icon={Download} label="导出这一格 PNG" disabled={pngBusy} onClick={() => void exportPng()} />
        </span>
      </PanelToolbar>

      <div className="flex flex-col gap-3 p-3">
        {editor.conflict && !readOnly && !isRevisionConflict(p.saveError) ? (
          <Notice tone="warn" title={`这个镜头的分镜已有更新的版本 v${editor.conflict.version}`}>
            <p>你在这里的修改还没有保存。载入最新版本会放弃这些修改。</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => editor.reset(editor.conflict!)}>
                <RefreshCw aria-hidden className="size-3.5" />
                载入最新版本
              </Button>
            </div>
          </Notice>
        ) : null}
        {p.saveError ? (
          isRevisionConflict(p.saveError) ? (
            <Notice tone="warn" title="保存失败：分镜已在别处更新" role="alert">
              <p>另一个窗口已经保存了更新的版本。请刷新后再保存；刷新会载入最新版本并放弃这里未保存的修改。</p>
              <div className="mt-2">
                <Button size="sm" onClick={() => editor.conflict && editor.reset(editor.conflict)} disabled={!editor.conflict}>
                  <RefreshCw aria-hidden className="size-3.5" />
                  {editor.conflict ? `刷新（载入 v${editor.conflict.version}）` : '正在读取最新版本…'}
                </Button>
              </div>
            </Notice>
          ) : (
            <ErrorNotice error={p.saveError} context="shot-save" />
          )
        ) : null}
        {latest.stale && !readOnly ? (
          <Notice tone="warn" title="镜头内容已修改" role="status">
            <p>这一格是按修改前的镜头画的。</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" busy={p.regenerating} disabled={p.keeping} onClick={p.onRegenerate}>
                重新生成（会丢失手动调整）
              </Button>
              <Button size="sm" busy={p.keeping} disabled={p.regenerating} onClick={p.onKeep}>
                保留我的调整
              </Button>
            </div>
          </Notice>
        ) : null}
        {p.staleError ? <ErrorNotice error={p.staleError} /> : null}
        {pngError ? <ErrorNotice error={pngError} /> : null}
        {viewing ? (
          <Notice tone="info" title={`正在查看旧版本 ${versionLabel(viewing)}（只读）`}>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => p.onView(null)}>
                回到最新版本
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  editor.commit(`恢复 v${viewing.version}`, viewing.spec);
                  p.onView(null);
                }}
              >
                以此版本继续编辑
              </Button>
            </div>
          </Notice>
        ) : null}

        {ai.job && ai.job.status !== 'succeeded' ? (
          <div className="flex flex-col gap-1">
            <RedrawJobNotice job={ai.job} onCancel={() => ai.job && cancel.mutate(ai.job.id)} cancelling={cancel.isPending} />
            {isTerminalJob(ai.job) ? (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => untrackJob(redrawSlot(latest.shot_id))}>
                知道了
              </Button>
            ) : null}
          </div>
        ) : null}
        {!readOnly ? <AiBar ai={ai} actions={rasterActions} /> : null}

        <PaperCanvas variant="fill" label={`镜 ${latest.shot_code} 分镜稿`}>
          <BoardCanvas
            spec={spec}
            mode={mode}
            code={latest.shot_code}
            alt={`镜 ${latest.shot_code} 的${RENDER_MODE_LABEL[editor.dragging ? 'structure' : mode]}`}
            editor={readOnly ? null : editor}
            ai={aiLayer}
          />
        </PaperCanvas>

        {!readOnly ? (
          <RasterList ai={ai} actions={rasterActions} spec={editor.present} blocked={setupBlocked}>
            {ai.leftBehind ? (
              ai.leftBehindStale ? (
                <Notice tone="warn" title={STALE_TITLE} role="status">
                  v{ai.leftBehind.board_version} 采用的 AI 图对应旧构图；当前版本 v{latest.version} 的大图和导出改用铅笔稿。不会自动重绘，需要时再点"AI 铅笔重绘"。
                </Notice>
              ) : (
                <Notice tone="info" title={`采用记录属于 v${ai.leftBehind.board_version}`}>
                  构图没有变化，但采用只对那个版本生效；当前版本的大图和导出使用铅笔稿。
                </Notice>
              )
            ) : null}
          </RasterList>
        ) : null}

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
          <Paper label="镜头说明">
            <CaptionBlock board={shown} shot={shot} />
          </Paper>
          <Paper label="俯视站位">
            <p className="mb-1.5 flex items-center justify-between text-xs text-ink/70">
              <span>俯视 · 站位示意</span>
              <span>只读</span>
            </p>
            <Topview spec={spec} />
          </Paper>
        </div>
        {!readOnly ? <p className="text-xs text-graphite-300">撤销 ⌘Z / Ctrl+Z · 重做 ⇧⌘Z / Ctrl+Shift+Z。修改只有在"保存为新版本"后才写入项目。</p> : null}
      </div>
      {confirming && imageView ? (
        <RedrawDialog
          board={p.board}
          fields={shot?.fields}
          provider={imageView}
          busy={redraw.isPending}
          error={redraw.error}
          onClose={() => {
            setConfirming(false);
            redraw.reset();
          }}
          onConfirm={(quality) =>
            redraw.mutate(
              { boardId: p.board.id, shotId: p.board.shot_id, quality },
              {
                onSuccess: () => {
                  setConfirming(false);
                  redraw.reset();
                },
              },
            )
          }
        />
      ) : null}
    </Panel>
  );
}
