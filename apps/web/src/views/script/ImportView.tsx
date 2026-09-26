import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { CurrentScript, HeadingOverride, ScriptFormat, ScriptImportResult, ScriptPreview } from '@storyscript/contracts';
import { FileUp, PencilLine, ScanText, ScrollText, Upload } from 'lucide-react';
import { SCRIPT_FORMAT_LABEL } from '../../lib/labels.ts';
import { useImportScript, usePreviewScript } from '../../lib/queries.ts';
import {
  ACCEPT_ATTR,
  formatFromFileName,
  isAcceptedFileName,
  isHeadingLine,
  MAX_SCRIPT_CHARS,
  pastedSourceName,
  splitLines,
  toggleHeadingOverride,
} from '../../lib/scriptImport.ts';
import { stageDef } from '../../lib/stages.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Notice, SelectInput, Spinner, TextInput } from '../../components/ui.tsx';
import { EmptyState, PageHeader, PaperCanvas, Panel, Workspace } from '../../components/workspace.tsx';

/**
 * Script import (FR-02): paste or pick a .txt/.md/.fountain file (read in the
 * browser only), preview the rule-based scene split on paper, flip heading
 * lines by hand (heading_overrides), then import as a new immutable version.
 *
 *   left: source (file, name, format)   main: text ↔ preview   right: scenes + import
 */

const FORMATS: readonly ScriptFormat[] = ['paste', 'txt', 'md', 'fountain'];

interface Previewed {
  text: string;
  format: ScriptFormat;
  result: ScriptPreview;
}

export interface ImportViewProps {
  /** current version, when importing a new one on top of it */
  base: CurrentScript | null;
  onCancel?: () => void;
  onDone: (result: ScriptImportResult) => void;
}

const lineDomId = (n: number) => `import-line-${n}`;

export function ImportView({ base, onCancel, onDone }: ImportViewProps) {
  const preview = usePreviewScript();
  const importer = useImportScript();

  const [text, setText] = useState(base?.version.raw_text ?? '');
  const [sourceName, setSourceName] = useState(base?.version.source_name ?? '');
  const [format, setFormat] = useState<ScriptFormat>(base?.version.format ?? 'paste');
  const [overrides, setOverrides] = useState<HeadingOverride[]>([]);
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

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const runPreview = (body: { text: string; overrides: HeadingOverride[]; format: ScriptFormat }) => {
    if (body.text.trim() === '' || body.text.length > MAX_SCRIPT_CHARS) return;
    preview.mutate(
      { text: body.text, source_name: effectiveName, format: body.format, heading_overrides: body.overrides },
      {
        onSuccess: (result) => {
          setPreviewed({ text: body.text, format: body.format, result });
          setMode('preview');
        },
      },
    );
  };

  const schedulePreview = (nextOverrides: HeadingOverride[]) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => runPreview({ text, overrides: nextOverrides, format }), 250);
  };

  const onTextChange = (next: string) => {
    setText(next);
    // line numbers shift with edits, so hand-set headings no longer apply
    if (overrides.length > 0) setOverrides([]);
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
      setOverrides([]);
      runPreview({ text: content, overrides: [], format: fmt });
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

  const detected = useMemo(() => new Set(previewed?.result.detected_heading_lines ?? []), [previewed]);
  const lines = useMemo(() => (previewed ? splitLines(previewed.text) : []), [previewed]);

  const toggle = (line: number) => {
    const next = toggleHeadingOverride(overrides, detected, line);
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
    importer.mutate({ text: previewed.text, source_name: effectiveName, format: previewed.format, heading_overrides: overrides }, { onSuccess: onDone });
  };

  const result = previewed?.result ?? null;
  const unassigned = result ? result.paragraphs.filter((p) => p.scene_idx === null).length : 0;
  const lineOf = (pid: string | undefined) => result?.paragraphs.find((p) => p.id === pid)?.line ?? null;
  const canPreview = text.trim() !== '' && !tooLong;

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
          <p className="text-xs text-graphite-300">.txt、.md 或 .fountain，也可以直接粘贴或拖进文本区。文件只在浏览器里读取。</p>
        </div>
        <Field label="来源名称" hint="用于版本列表，例如文件名。">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="粘贴的剧本" maxLength={200} />
          )}
        </Field>
        <Field label="格式" hint="决定场景标题的识别规则。">
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
          {result ? '重新识别场景' : '识别场景'}
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
        场景预览
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
              placeholder={'1. 内景 旧书店 夜\n店主在柜台后整理旧书……\n\n也可以把文件拖到这里。'}
              aria-invalid={tooLong || undefined}
              className="min-h-0 w-full flex-1 resize-none bg-transparent text-base text-ink placeholder:text-ink/60"
            />
          </PaperCanvas>
        </div>
      </Panel>
    ) : (
      <Panel title="场景预览" tools={modeTool}>
        {stale ? (
          <Notice tone="warn" title="文本或格式在识别后被修改过" className="mb-3">
            点"重新识别场景"更新预览后才能导入。
          </Notice>
        ) : null}
        <p className="mb-2 text-xs text-graphite-300">
          点击行首的"场"字方框，把这一行设为场景标题或取消。共 {lines.length} 行，规则识别出 {detected.size} 个标题
          {overrides.length > 0 ? `，手动调整 ${overrides.length} 处` : ''}。
        </p>
        <PaperCanvas label="剧本逐行预览">
          <ol className="-mx-2 flex flex-col">
            {lines.map((line, i) => {
              const n = i + 1;
              if (line.trim() === '') return <li key={n} aria-hidden className="h-3" />;
              const heading = isHeadingLine(n, detected, overrides);
              const manual = overrides.some((o) => o.line === n);
              return (
                <li
                  key={n}
                  id={lineDomId(n)}
                  className={`grid scroll-mt-4 grid-cols-[1.25rem_2rem_minmax(0,1fr)] items-start gap-x-2 rounded-paper px-2 [content-visibility:auto] ${heading ? 'bg-ink/[0.06]' : ''}`}
                >
                  <button
                    type="button"
                    aria-pressed={heading}
                    onClick={() => toggle(n)}
                    disabled={stale}
                    title={heading ? '取消场景标题' : '设为场景标题'}
                    aria-label={`第 ${n} 行：${heading ? '取消场景标题' : '设为场景标题'}`}
                    className={
                      'mt-[6px] inline-flex size-5 items-center justify-center rounded-control border text-[11px] leading-none ' +
                      (heading ? 'border-ink bg-ink text-paper' : 'border-ink/30 text-transparent hover:enabled:border-ink/60 hover:enabled:text-ink/60') +
                      ' disabled:cursor-not-allowed disabled:opacity-50'
                    }
                  >
                    场
                  </button>
                  <span className="pt-[5px] text-right text-xs text-ink/60 tabular-nums select-none">{n}</span>
                  <span className={`min-w-0 break-words whitespace-pre-wrap ${heading ? 'font-medium' : ''}`}>
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

  const scenes = (
    <Panel title={result ? `识别出的场景 ${result.scenes.length}` : '识别出的场景'} padded={false} tools={preview.isPending && result ? <Spinner label="更新中" /> : undefined}>
      {!result ? (
        <EmptyState
          icon={ScanText}
          title="还没有识别。"
          description="粘贴剧本或选择文件后，点“识别场景”。这里会列出按场景标题切出的场景。"
        />
      ) : (
        <div className="flex min-h-full flex-col">
          {result.scenes.length === 0 ? (
            <div className="p-3">
              <Notice tone="warn" title="没有识别出场景标题">
                在预览里点击行首的方框，手动把某一行设为场景标题。
              </Notice>
            </div>
          ) : (
            <ol className="divide-y divide-graphite-800">
              {result.scenes.map((s, i) => {
                const line = lineOf(s.paragraph_ids[0]);
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
                          {s.paragraph_ids.length} 段{s.time_label ? ` · ${s.time_label}` : ''}
                          {s.location_label ? ` · ${s.location_label}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {unassigned > 0 ? <p className="px-3 py-2 text-xs text-graphite-300">第一个场景标题之前的 {unassigned} 段不属于任何场景。</p> : null}
          <div className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-graphite-800 bg-graphite-900 p-3">
            {importer.isError ? <ErrorNotice error={importer.error} context="script-import" /> : null}
            <p className="text-xs text-graphite-300">
              {result.scenes.length === 0
                ? '至少需要一个场景标题。'
                : `将创建 ${result.scenes.length} 个场景、${result.paragraphs.length} 个段落锚点。${base ? '旧版本仍然保留。' : ''}`}
            </p>
            <Button variant="primary" onClick={doImport} busy={importer.isPending} disabled={stale || preview.isPending || result.scenes.length === 0}>
              {importer.isPending ? null : <Upload aria-hidden className="size-3.5" />}
              导入为新版本
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
