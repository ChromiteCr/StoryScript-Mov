import { useCallback, useMemo, useRef, useState } from 'react';
import type { BoardView, Project, Scene, Shot } from '@storyscript/contracts';
import { frameSize } from '@storyscript/core';
import { ArrowLeft, Printer } from 'lucide-react';
import { paginateBoards, paginateTopviews, type PrintCell, type PrintPage } from '../../lib/print-boards.ts';
import { rasterImageUrl, readAiLabelPref } from '../../lib/queries-raster.ts';
import { Button, SelectInput } from '../../components/ui.tsx';
import { AiBadge } from './AiLayer.tsx';
import { boardUrl } from './images.ts';
import { overlayOnlyUrl } from './raster-layers.ts';

/**
 * Print views (FR-10, browser print CSS): the board PDF — frames of aspect
 * ≥ 2.2 three to a page, narrower ones two, each scene on its own pages — and
 * the topview (站位示意) pages. Pages are A4 portrait sheets on screen and in
 * print; white paper, black ink, greyscale pictures, the app's Chinese font
 * stack. A page is marked 草案 unless all its shots are locked and current.
 * Printing waits until every picture has loaded.
 *
 * A frame whose board version has an adopted AI raster (FR-12) prints the
 * raster plus the vector annotation layer, with the "AI 生成" corner mark
 * unless the export preference turned it off (default on).
 */

export type PrintKind = 'boards' | 'topview';

export interface BoardPrintProps {
  kind: PrintKind;
  project: Project;
  boards: BoardView[];
  shots: Shot[];
  scenes: Pick<Scene, 'id' | 'display_no' | 'heading'>[];
  scriptVersion: string | null;
  sceneId: string | null;
  onScene: (id: string | null) => void;
  onBack: () => void;
  /** where the back button goes (the deliver page opens the same preview) */
  backLabel?: string;
}

function DraftMark({ draft }: { draft: boolean }) {
  return (
    <span
      className={
        'inline-flex h-7 shrink-0 items-center rounded-control border-2 px-2.5 text-sm font-medium tracking-widest ' +
        (draft ? 'border-ink text-ink' : 'border-ink/40 text-ink/75')
      }
    >
      {draft ? '草案' : '定稿'}
    </span>
  );
}

function PageHead({ page, total, project, scriptVersion, title }: { page: PrintPage; total: number; project: Project; scriptVersion: string | null; title: string }) {
  return (
    <header className="mb-3 flex items-start justify-between gap-3 border-b border-ink/40 pb-2">
      <div className="min-w-0">
        <p className="text-xs text-ink/75">{project.name}</p>
        <h2 className="text-lg font-medium text-ink">
          {title} · {page.scene.label}
        </h2>
        <p className="text-xs text-ink/75 tabular-nums">
          {scriptVersion ? `${scriptVersion} · ` : ''}打印于 {new Date().toLocaleDateString('zh-CN')} · 第 {page.no} / {total} 页
        </p>
      </div>
      <DraftMark draft={page.draft} />
    </header>
  );
}

/** Adopted AI raster + annotation layer (+ corner mark); loaded once both images decoded. */
function AiPicture({ cell, rasterId, label, onLoad }: { cell: PrintCell; rasterId: string; label: boolean; onLoad: (key: string) => void }) {
  const spec = cell.board.spec;
  const code = cell.board.shot_code;
  const overlayUrl = useMemo(() => overlayOnlyUrl(spec, code), [spec, code]);
  const { W, H } = frameSize(spec.frame.aspect);
  const key = `${cell.board.id}:pencil`;
  const count = useRef(0);
  const done = () => {
    count.current += 1;
    if (count.current >= 2) onLoad(key);
  };
  return (
    <div className="relative border border-ink/60" data-ai-raster={rasterId}>
      <img src={rasterImageUrl(rasterId)} alt={`镜 ${cell.caption.code}（AI 生成，已人工采用）`} onLoad={done} onError={done} className="block h-auto w-full print:grayscale" />
      <img src={overlayUrl} alt="" onLoad={done} onError={done} className="absolute inset-0 block h-full w-full" />
      {label ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="AI 生成" className="pointer-events-none absolute inset-0 h-full w-full">
          <AiBadge spec={spec} code={code} />
        </svg>
      ) : null}
    </div>
  );
}

function Picture({ cell, mode, onLoad, aiLabel }: { cell: PrintCell; mode: 'pencil' | 'topview'; onLoad: (key: string) => void; aiLabel: boolean }) {
  const url = useMemo(() => boardUrl({ spec: cell.board.spec, mode, overlay: true, code: cell.board.shot_code }), [cell.board, mode]);
  const key = `${cell.board.id}:${mode}`;
  if (mode === 'pencil' && cell.board.adopted_raster_id) {
    return <AiPicture cell={cell} rasterId={cell.board.adopted_raster_id} label={aiLabel} onLoad={onLoad} />;
  }
  return (
    <img
      src={url}
      alt={`镜 ${cell.caption.code}`}
      onLoad={() => onLoad(key)}
      onError={() => onLoad(key)}
      className="block h-auto w-full border border-ink/60 print:grayscale"
    />
  );
}

function Caption({ cell }: { cell: PrintCell }) {
  const c = cell.caption;
  return (
    <dl className="grid grid-cols-[3.2em_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs leading-snug text-ink">
      <dt className="text-ink/70">镜号</dt>
      <dd>
        <span className="text-sm font-medium tabular-nums">{c.code}</span>
        <span className="ml-1.5 text-ink/70">{c.version}</span>
        {c.stale ? <span className="ml-1.5 text-ink/80">（镜头已改）</span> : null}
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

export function BoardPrint({ kind, project, boards, shots, scenes, scriptVersion, sceneId, onScene, onBack, backLabel = '返回分镜' }: BoardPrintProps) {
  const pages = useMemo(
    () => (kind === 'boards' ? paginateBoards(boards, shots, scenes, sceneId) : paginateTopviews(boards, shots, scenes, sceneId)),
    [kind, boards, shots, scenes, sceneId],
  );
  const keys = useMemo(
    () => pages.flatMap((p) => p.cells.flatMap((c) => (kind === 'boards' ? ['pencil'] : ['topview', 'pencil']).map((m) => `${c.board.id}:${m}`))),
    [pages, kind],
  );
  const total = keys.length;
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const markLoaded = useCallback((key: string) => setDone((s) => (s.has(key) ? s : new Set(s).add(key))), []);
  const loaded = keys.filter((k) => done.has(k)).length;
  const ready = loaded >= total;
  const title = kind === 'boards' ? '分镜' : '俯视站位';
  const sceneIds = [...new Set(boards.map((b) => b.scene_id))];
  const aiLabel = useMemo(() => readAiLabelPref(project.id), [project.id]);

  return (
    <div className="flex min-h-full flex-col gap-1 p-1 print:block print:bg-print-paper print:p-0">
      <div className="flex flex-wrap items-center gap-2 rounded-panel bg-graphite-900 px-2 py-1.5 print:hidden">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-3.5" />
          {backLabel}
        </Button>
        <h1 className="text-sm font-medium text-graphite-100">{title}打印预览</h1>
        <SelectInput aria-label="打印范围" className="h-6 w-auto max-w-[240px] text-xs" value={sceneId ?? ''} onChange={(e) => onScene(e.target.value || null)}>
          <option value="">全部场景</option>
          {sceneIds.map((id) => {
            const s = scenes.find((x) => x.id === id);
            return (
              <option key={id} value={id}>
                {s ? `第 ${s.display_no} 场 · ${s.heading}` : '其他场景'}
              </option>
            );
          })}
        </SelectInput>
        <p className="min-w-0 text-xs text-graphite-300">
          {kind === 'boards' ? '宽于 2.2 的画幅每页 3 格，其余每页 2 格。' : '每页 3 个镜头：俯视站位和对应的分镜格。'}用浏览器打印；需要 PDF 时在打印对话框里选"存储为 PDF"。
        </p>
        <Button size="sm" variant="primary" className="ml-auto" disabled={!ready || total === 0} busy={!ready && total > 0} onClick={() => window.print()}>
          <Printer aria-hidden className="size-3.5" />
          {ready ? '打印' : `准备图片 ${Math.min(loaded, total)}/${total}`}
        </Button>
      </div>

      {total === 0 ? (
        <p className="p-4 text-sm text-graphite-300">没有可打印的分镜。</p>
      ) : (
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 print:block print:max-w-none">
          {pages.map((page) => (
            <section
              key={page.no}
              data-paper=""
              data-print-page={page.no}
              aria-label={`第 ${page.no} 页`}
              className="rounded-paper bg-paper p-6 text-ink [color-scheme:light] break-after-page print:rounded-none print:bg-print-paper print:p-0 print:text-print-ink print:last:break-after-auto"
            >
              <PageHead page={page} total={pages.length} project={project} scriptVersion={scriptVersion} title={title} />
              {kind === 'boards' ? (
                <div className={`flex flex-col ${page.per === 3 ? 'gap-4' : 'gap-6'}`}>
                  {page.cells.map((cell) => (
                    <article
                      key={cell.board.id}
                      data-print-cell={cell.caption.code}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.42fr)] items-start gap-3 break-inside-avoid print:grid-cols-[128mm_minmax(0,1fr)]"
                    >
                      <Picture cell={cell} mode="pencil" onLoad={markLoaded} aiLabel={aiLabel} />
                      <Caption cell={cell} />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {page.cells.map((cell) => (
                    <article
                      key={cell.board.id}
                      data-print-cell={cell.caption.code}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)] items-start gap-3 break-inside-avoid print:grid-cols-[112mm_minmax(0,1fr)]"
                    >
                      <div className="flex flex-col gap-1">
                        <Picture cell={cell} mode="topview" onLoad={markLoaded} aiLabel={aiLabel} />
                        <p className="text-xs text-ink/70">俯视 · 站位示意（非实景测量）</p>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Picture cell={cell} mode="pencil" onLoad={markLoaded} aiLabel={aiLabel} />
                        <p className="text-xs text-ink">
                          <span className="text-sm font-medium tabular-nums">{cell.caption.code}</span>
                          <span className="ml-1.5 text-ink/70">{cell.caption.version}</span>
                        </p>
                        <p className="text-xs text-ink">{cell.caption.grammar}</p>
                        <p className="line-clamp-2 text-xs text-ink/80">{cell.caption.action}</p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
