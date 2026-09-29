import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { CurrentScript, HeadingOverride, ScriptFormat, ScriptImportResult, ScriptPreview, ShotLinePreview, ShotOverride } from '@storyscript/contracts';
import { FileUp, PencilLine, ScanText, ScrollText, Upload } from 'lucide-react';
import { MOVEMENT_LABEL, SCRIPT_FORMAT_LABEL, SHOT_SIZE_LABEL } from '../../lib/labels.ts';
import { useImportScript, usePreviewScript } from '../../lib/queries.ts';
import {
  ACCEPT_ATTR,
  cycleLineRole,
  formatFromFileName,
  isAcceptedFileName,
  lineRole,
  MAX_SCRIPT_CHARS,
  pastedSourceName,
  splitLines,
  type LineRole,
} from '../../lib/scriptImport.ts';
import { stageDef } from '../../lib/stages.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Notice, SelectInput, Spinner, TextInput } from '../../components/ui.tsx';
import { EmptyState, PageHeader, PaperCanvas, Panel, Workspace } from '../../components/workspace.tsx';

/**
 * Script import (FR-02, S2c): paste or pick a .txt/.md/.fountain file (read in
 * the browser only), preview how the rules read each line on paper — a scene
 * heading (场), a shot (镜) or plain text — change any line by clicking its
 * tag, then import as a new immutable version. A shot list (one shot per line,
 * or a 镜号/景别/画面 table) imports its lines as shots, not as scenes.
 *
 *   left: source (file, name, format)   main: text ↔ preview   right: scenes, their shots, import
 */

const FORMATS: readonly ScriptFormat[] = ['paste', 'txt', 'md', 'fountain'];

interface Previewed {
  text: string;
  format: ScriptFormat;
  result: ScriptPreview;
}

interface Overrides {
  heading: HeadingOverride[];
  shot: ShotOverride[];
}

const NO_OVERRIDES: Overrides = { heading: [], shot: [] };

export interface ImportViewProps {
  /** current version, when importing a new one on top of it */
  base: CurrentScript | null;
  onCancel?: () => void;
  onDone: (result: ScriptImportResult) => void;
}

const lineDomId = (n: number) => `import-line-${n}`;

const ROLE_TAG: Record<LineRole, { mark: string; name: string; next: string }> = {
  text: { mark: '', name: '正文', next: '设为场次标题' },
  heading: { mark: '场', name: '场次标题', next: '改为镜头' },
  shot: { mark: '镜', name: '镜头', next: '改回正文' },
};

/** "全景 · 手持 · 4 秒 · 教室里只剩小林一个人" */
function shotSummary(s: ShotLinePreview): string {
  const i = s.info;
  const parts = [
    i.shot_size ? SHOT_SIZE_LABEL[i.shot_size] : null,
    i.movement && i.movement !== 'static' ? MOVEMENT_LABEL[i.movement] : null,
    i.est_seconds !== null ? `${i.est_seconds} 秒` : null,
    i.action || null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function ImportView({ base, onCancel, onDone }: ImportViewProps) {
  const preview = usePreviewScript();
  const importer = useImportScript();

  const [text, setText] = useState(base?.version.raw_text ?? '');
  const [sourceName, setSourceName] = useState(base?.version.source_name ?? '');
  const [format, setFormat] = useState<ScriptFormat>(base?.version.format ?? 'paste');
  const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  const tooLong = text.length > MAX_SCRIPT_CHARS;
  const stale = previewed !== null && (previewed.text !== text || previewed.format !== format);
  const effectiveName = sourceName.trim() || pastedSourceName(new Date());
  const { label, lead } = stageDef('script');
  const overrideCount = overrides.heading.length + overrides.shot.length;

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const runPreview = (body: { text: string; overrides: Overrides; format: ScriptFormat }) => {
    if (body.text.trim() === '' || body.text.length > MAX_SCRIPT_CHARS) return;
    preview.mutate(
      {
        text: body.text,
        source_name: effectiveName,
        format: body.format,
        heading_overrides: body.overrides.heading,
        shot_overrides: body.overrides.shot,
      },
      {
        onSuccess: (result) => {
          setPreviewed({ text: body.text, format: body.format, result });
          setMode('preview');
        },
      },
    );
  };

  const schedulePreview = (next: Overrides) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => runPreview({ text, overrides: next, format }), 250);
  };

  const onTextChange = (next: string) => {
    setText(next);
    // line numbers shift with edits, so hand-set lines no longer apply
    if (overrideCount > 0) setOverrides(NO_OVERRIDES);
  };

  const loadFile = (file: File) => {
    setFileError(null);
    if (!isAcceptedFileName(file.name)) {
      setFileError('只支持 .txt、.md 和 .fountain 文件。');
      return;
    }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      setReading(false);
      const content = typeof reader.result === 'string' ? reader.result.replace(/^﻿/, '') : '';
      if (content.length > MAX_SCRIPT_CHARS) {
        setFileError(`文件超过 ${MAX_SCRIPT_CHARS.toLocaleString('zh-CN')} 个字符，无法导入。`);
        return;
      }
      const fmt = formatFromFileName(file.name);
      setText(content);
      setSourceName(file.name);
      setFormat(fmt);
      setOverrides(NO_OVERRIDES);
      runPreview({ text: content, overrides: NO_OVERRIDES, format: fmt });
    };
    reader.onerror = () => {
      setReading(false);
      setFileError('读取文件失败。确认文件是 UTF-8 编码的文本。');
    };
    reader.readAsText(file, 'utf-8');
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  };

  const detected = useMemo(
    () => ({ headings: new Set(previewed?.result.detected_heading_lines ?? []), shots: new Set(previewed?.result.detected_shot_lines ?? []) }),
    [previewed],
  );
  const lines = useMemo(() => (previewed ? splitLines(previewed.text) : []), [previewed]);

  const cycle = (line: number) => {
    const next = cycleLineRole(line, detected, overrides);
    setOverrides(next);
    schedulePreview(next);
  };

  const scrollToLine = (line: number) => {
    setMode('preview');
    window.requestAnimationFrame(() => {
      const el = document.getElementById(lineDomId(line));
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    });
  };

  const doImport = () => {
    if (!previewed || stale) return;
    importer.mutate(
      {
        text: previewed.text,
        source_name: effectiveName,
        format: previewed.format,
        heading_overrides: overrides.heading,
        shot_overrides: overrides.shot,
      },
      { onSuccess: onDone },
    );
  };

  const result = previewed?.result ?? null;
  const unassigned = result ? result.paragraphs.filter((p) => p.scene_idx === null).length : 0;
  const lineOf = (pid: string | undefined) => result?.paragraphs.find((p) => p.id === pid)?.line ?? null;
  const canPreview = text.trim() !== '' && !tooLong;
  const shotsIn = (idx: number) => result?.shot_lines.filter((s) => s.scene_idx === idx) ?? [];
  const shotCount = result ? result.shot_lines.filter((s) => s.scene_idx !== null).length : 0;
  const strayShots = result ? result.shot_lines.length - shotCount : 0;

  // ------------------------------------------------------------ panels

  const source = (
    <Panel title="来源">
      <div className="flex flex-col gap-3">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_ATTR}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.target.value = '';
          }}
        />
        <div className="flex flex-col gap-1">
          <Button onClick={() => fileInput.current?.click()} busy={reading} className="w-full">
            {reading ? null : <FileUp aria-hidden className="size-3.5" />}
            选择文件
          </Button>
          <p className="text-xs text-graphite-300">
            .txt、.md 或 .fountain，也可以直接粘贴或拖进文本区。剧本和分镜脚本（每行一个镜头，或从表格复制的镜号、景别、画面）都可以。文件只在浏览器里读取。
          </p>
        </div>
        <Field label="来源名称" hint="用于版本列表，例如文件名。">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="粘贴的剧本" maxLength={200} />
          )}
        </Field>
        <Field label="格式" hint="决定场次标题的识别规则。">
          {({ id, describedBy }) => (
            <SelectInput id={id} aria-describedby={describedBy} value={format} onChange={(e) => setFormat(e.target.value as ScriptFormat)}>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {SCRIPT_FORMAT_LABEL[f]}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
        <p className="text-xs text-graphite-300 tabular-nums">{text.length.toLocaleString('zh-CN')} 字符</p>
        {tooLong ? <Notice tone="danger" title={`剧本超过 ${MAX_SCRIPT_CHARS.toLocaleString('zh-CN')} 个字符，无法导入`} /> : null}
        {fileError ? <Notice tone="danger" title={fileError} /> : null}
        <Button
          variant={result && !stale ? 'secondary' : 'primary'}
          onClick={() => runPreview({ text, overrides, format })}
          disabled={!canPreview}
          busy={preview.isPending && !result}
          className="w-full"
        >
          {preview.isPending && !result ? null : <ScanText aria-hidden className="size-3.5" />}
          {result ? '重新识别' : '识别场次和镜头'}
        </Button>
        {preview.isError ? <ErrorNotice error={preview.error} context="script-import" /> : null}
      </div>
    </Panel>
  );

  const modeTool =
    mode === 'preview' ? (
      <Button variant="ghost" size="sm" onClick={() => setMode('edit')}>
        <PencilLine aria-hidden className="size-3" />
        编辑文本
      </Button>
    ) : result ? (
      <Button variant="ghost" size="sm" onClick={() => setMode('preview')}>
        <ScanText aria-hidden className="size-3" />
        逐行预览
      </Button>
    ) : undefined;

  const main =
    mode === 'edit' || !result ? (
      <Panel title="剧本文本" tools={modeTool} bodyClassName="flex flex-col">
        <div
          className={`flex min-h-0 flex-1 flex-col rounded-paper outline-offset-2 ${dragOver ? 'outline-2 outline-dashed outline-graphite-300' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <PaperCanvas variant="fill" className="flex min-h-[55dvh] flex-1 flex-col lg:min-h-0">
            <textarea
              aria-label="剧本文本"
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              spellCheck={false}
              placeholder={'1. 内景 旧书店 夜\n店主在柜台后整理旧书……\n\n分镜脚本也可以：\n1. 全景 书店里只有店主一个人 4秒\n\n也可以把文件拖到这里。'}
              aria-invalid={tooLong || undefined}
              className="min-h-0 w-full flex-1 resize-none bg-transparent text-base text-ink placeholder:text-ink/60"
            />
          </PaperCanvas>
        </div>
      </Panel>
    ) : (
      <Panel title="逐行预览" tools={modeTool}>
        {stale ? (
          <Notice tone="warn" title="文本或格式在识别后被修改过" className="mb-3">
            点"重新识别"更新预览后才能导入。
          </Notice>
        ) : null}
        {result.kind === 'shot_list' ? (
          <Notice tone="info" title={`这是分镜脚本：识别出 ${result.scenes.length} 场、${shotCount} 个镜头`} className="mb-3">
            每个标着「镜」的行会导入为一个镜头，不会被当作一场。场次按场次标题划分；没有标题时，按表格里的场次或场景列划分，都没有就整篇算一场。
          </Notice>
        ) : null}
        <p className="mb-2 text-xs text-graphite-300">
          点行首的方框切换这一行是什么：空白是正文，「场」是场次标题，「镜」是一个镜头。共 {lines.length} 行，规则识别出 {detected.headings.size} 个场次标题、
          {detected.shots.size} 个镜头{overrideCount > 0 ? `，手动调整 ${overrideCount} 处` : ''}。
        </p>
        <PaperCanvas label="剧本逐行预览">
          <ol className="-mx-2 flex flex-col">
            {lines.map((line, i) => {
              const n = i + 1;
              if (line.trim() === '') return <li key={n} aria-hidden className="h-3" />;
              const role = lineRole(n, detected, overrides);
              const tag = ROLE_TAG[role];
              const manual = overrides.heading.some((o) => o.line === n) || overrides.shot.some((o) => o.line === n);
              return (
                <li
                  key={n}
                  id={lineDomId(n)}
                  className={`grid scroll-mt-4 grid-cols-[1.25rem_2rem_minmax(0,1fr)] items-start gap-x-2 rounded-paper px-2 [content-visibility:auto] ${role === 'heading' ? 'bg-ink/[0.06]' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => cycle(n)}
                    disabled={stale}
                    title={`${tag.name}：点击${tag.next}`}
                    aria-label={`第 ${n} 行是${tag.name}，点击${tag.next}`}
                    className={
                      'mt-[6px] inline-flex size-5 items-center justify-center rounded-control border text-[11px] leading-none ' +
                      (role === 'heading'
                        ? 'border-ink bg-ink text-paper'
                        : role === 'shot'
                          ? 'border-ink text-ink'
                          : 'border-ink/30 text-transparent hover:enabled:border-ink/60') +
                      ' disabled:cursor-not-allowed disabled:opacity-50'
                    }
                  >
                    {tag.mark}
                  </button>
                  <span className="pt-[5px] text-right text-xs text-ink/60 tabular-nums select-none">{n}</span>
                  <span className={`min-w-0 break-words whitespace-pre-wrap ${role === 'heading' ? 'font-medium' : ''}`}>
                    {line}
                    {manual ? <span className="ml-2 inline-block rounded-control border border-ink/40 px-1 align-[2px] text-xs leading-4 text-ink/75">手动</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </PaperCanvas>
      </Panel>
    );

  const importLabel = shotCount > 0 ? `导入 ${result?.scenes.length ?? 0} 场和 ${shotCount} 个镜头` : '导入为新版本';

  const scenes = (
    <Panel title={result ? `场次 ${result.scenes.length}` : '场次'} padded={false} tools={preview.isPending && result ? <Spinner label="更新中" /> : undefined}>
      {!result ? (
        <EmptyState
          icon={ScanText}
          title="还没有识别。"
          description="粘贴剧本或分镜脚本、或者选择文件后，点“识别场次和镜头”。这里会列出切出的场次，以及每场会导入的镜头。"
        />
      ) : (
        <div className="flex min-h-full flex-col">
          {result.scenes.length === 0 ? (
            <div className="p-3">
              <Notice tone="warn" title="没有识别出场次">
                在预览里点击行首的方框，把某一行设为场次标题（「场」）。
              </Notice>
            </div>
          ) : (
            <ol className="divide-y divide-graphite-800">
              {result.scenes.map((s, i) => {
                const line = lineOf(s.paragraph_ids[0]);
                const sceneShots = shotsIn(i);
                return (
                  <li key={`${s.display_no}-${i}`}>
                    <button
                      type="button"
                      onClick={() => (line ? scrollToLine(line) : undefined)}
                      className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-graphite-800 focus-visible:outline-offset-[-2px]"
                    >
                      <span className="w-8 shrink-0 text-xs text-graphite-300 tabular-nums">{s.display_no}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm break-words text-graphite-100">{s.heading}</span>
                        <span className="block text-xs text-graphite-300">
                          {sceneShots.length > 0 ? `${sceneShots.length} 个镜头` : `${s.paragraph_ids.length} 段`}
                          {s.time_label ? ` · ${s.time_label}` : ''}
                          {s.location_label ? ` · ${s.location_label}` : ''}
                        </span>
                      </span>
                    </button>
                    {sceneShots.length > 0 ? (
                      <ol aria-label={`第 ${s.display_no} 场的镜头`} className="flex flex-col gap-0.5 pb-2 pl-13 pr-3">
                        {sceneShots.map((shot, k) => (
                          <li key={shot.line}>
                            <button
                              type="button"
                              onClick={() => scrollToLine(shot.line)}
                              className="flex w-full items-baseline gap-2 rounded-control px-1 py-0.5 text-left text-xs text-graphite-300 hover:bg-graphite-800 hover:text-graphite-100"
                            >
                              <span className="w-5 shrink-0 tabular-nums">{k + 1}</span>
                              <span className="min-w-0 flex-1 truncate">{shotSummary(shot)}</span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {unassigned > 0 ? <p className="px-3 py-2 text-xs text-graphite-300">第一个场次之前的 {unassigned} 段不属于任何场次。</p> : null}
          {strayShots > 0 ? <p className="px-3 pb-2 text-xs text-graphite-300">其中 {strayShots} 行镜头在第一个场次之前，不会导入为镜头。</p> : null}
          <div className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-graphite-800 bg-graphite-900 p-3">
            {importer.isError ? <ErrorNotice error={importer.error} context="script-import" /> : null}
            <p className="text-xs text-graphite-300">
              {result.scenes.length === 0
                ? '至少需要一个场次。'
                : `将创建 ${result.scenes.length} 场${shotCount > 0 ? `、${shotCount} 个镜头` : ''}、${result.paragraphs.length} 个段落锚点。${base ? '旧版本仍然保留；已有镜头的行不会重复创建。' : ''}`}
            </p>
            <Button variant="primary" onClick={doImport} busy={importer.isPending} disabled={stale || preview.isPending || result.scenes.length === 0}>
              {importer.isPending ? null : <Upload aria-hidden className="size-3.5" />}
              {importLabel}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );

  return (
    <Workspace
      header={
        <PageHeader
          title={base ? `${label} · 导入新版本` : label}
          icon={ScrollText}
          lead={base ? '新版本不会覆盖旧版本。旧镜头引用的原文能在新版本里逐字找到的沿用，找不到的标为"待重新关联"。' : lead}
          actions={
            onCancel ? (
              <Button variant="ghost" onClick={onCancel} disabled={importer.isPending}>
                取消
              </Button>
            ) : undefined
          }
        />
      }
      left={source}
      right={scenes}
    >
      {main}
    </Workspace>
  );
}
