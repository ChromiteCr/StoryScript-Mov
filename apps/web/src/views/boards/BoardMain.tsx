import { useMemo, useState, type ReactNode } from 'react';
import type { Board, BoardView, Project, Shot } from '@storyscript/contracts';
import { Download, History, Redo2, RefreshCw, Save, Undo2 } from 'lucide-react';
import { boardCaption, pngFileName } from '../../lib/print-boards.ts';
import { RENDER_MODE_LABEL, versionLabel, type BoardViewMode } from '../../lib/labels-boards.ts';
import { isRevisionConflict } from '../../lib/queries-boards.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, IconButton, Notice, SelectInput, Tag } from '../../components/ui.tsx';
import { PaperCanvas, Panel, PanelToolbar } from '../../components/workspace.tsx';
import { BoardCanvas } from './BoardCanvas.tsx';
import { composeBoardPng, downloadBlob } from './exportPng.ts';
import { useBoardUrl } from './images.ts';
import type { EditorApi } from './useEditor.ts';

/**
 * Main panel of the board page: toolbar (render mode, undo/redo, save as new
 * version, version history, PNG), the stale banner, the frame on paper with
 * its editing handles, the shot's caption and the read-only topview.
 */

const MODES: BoardViewMode[] = ['pencil', 'structure'];

export interface BoardMainProps {
  project: Project;
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

  const exportPng = async () => {
    setPngBusy(true);
    setPngError(null);
    try {
      const blob = await composeBoardPng(spec, boardCaption(shown, shot));
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
        <span className="ml-auto flex min-w-0 items-center gap-1">
          <History aria-hidden className="hidden size-3.5 shrink-0 text-graphite-300 sm:block" />
          <SelectInput
            aria-label="版本历史"
            className="h-6 w-auto max-w-[92px] text-xs sm:max-w-[180px]"
            value={viewing?.id ?? ''}
            onChange={(e) => p.onView(e.target.value || null)}
            disabled={!p.versions}
          >
            <option value="">{`最新 · ${versionLabel(latest)}`}</option>
            {(p.versions ?? [])
              .filter((v) => v.id !== latest.id)
              .slice()
              .reverse()
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v)} · {new Date(v.created_at).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}
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

        <PaperCanvas variant="fill" label={`镜 ${latest.shot_code} 分镜稿`}>
          <BoardCanvas
            spec={spec}
            mode={mode}
            code={latest.shot_code}
            alt={`镜 ${latest.shot_code} 的${RENDER_MODE_LABEL[editor.dragging ? 'structure' : mode]}`}
            editor={readOnly ? null : editor}
          />
        </PaperCanvas>

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
    </Panel>
  );
}
