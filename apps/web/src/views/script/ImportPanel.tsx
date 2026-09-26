import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { CurrentScript, HeadingOverride, ScriptFormat, ScriptImportResult, ScriptPreview } from '@storyscript/contracts';
import { FileUp, ScanText, Upload } from 'lucide-react';
import { usePreviewScript, useImportScript } from '../../lib/queries.ts';
import { SCRIPT_FORMAT_LABEL } from '../../lib/labels.ts';
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
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Note, Select, SectionHeading, Spinner, Tag, TextArea, TextInput } from '../../components/ui.tsx';

/**
 * Script import (FR-02): paste or pick a .txt/.md/.fountain file (read in the
 * browser only), preview the rule-based scene split, flip heading lines by
 * hand (heading_overrides), then import as a new immutable version.
 */

const FORMATS: readonly ScriptFormat[] = ['paste', 'txt', 'md', 'fountain'];

interface Previewed {
  text: string;
  result: ScriptPreview;
}

export interface ImportPanelProps {
  /** current version, when importing a new one on top of it */
  base: CurrentScript | null;
  onCancel?: () => void;
  onDone: (result: ScriptImportResult) => void;
}

export function ImportPanel({ base, onCancel, onDone }: ImportPanelProps) {
  const preview = usePreviewScript();
  const importer = useImportScript();

  const [text, setText] = useState(base?.version.raw_text ?? '');
  const [sourceName, setSourceName] = useState(base?.version.source_name ?? '');
  const [format, setFormat] = useState<ScriptFormat>(base?.version.format ?? 'paste');
  const [overrides, setOverrides] = useState<HeadingOverride[]>([]);
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);
  const linesBox = useRef<HTMLOListElement>(null);

  const tooLong = text.length > MAX_SCRIPT_CHARS;
  const stale = previewed !== null && previewed.text !== text;
  const effectiveName = sourceName.trim() || pastedSourceName(new Date());

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
      { onSuccess: (result) => setPreviewed({ text: body.text, result }) },
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
    const el = linesBox.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const doImport = () => {
    if (!previewed || stale) return;
    importer.mutate(
      { text: previewed.text, source_name: effectiveName, format, heading_overrides: overrides },
      { onSuccess: onDone },
    );
  };

  const result = previewed?.result ?? null;
  const unassigned = result ? result.paragraphs.filter((p) => p.scene_idx === null).length : 0;
  const lineOf = (pid: string | undefined) => result?.paragraphs.find((p) => p.id === pid)?.line ?? null;

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-sheet border border-rule bg-sheet px-4 py-4 sm:px-6 sm:py-5">
        <SectionHeading
          title={base ? '导入新版本' : '导入剧本'}
          description={
            base
              ? '新版本不会覆盖旧版本。旧镜头引用的原文能在新版本里逐字找到的沿用，找不到的标为"待重新关联"。'
              : '粘贴剧本文本，或选择 .txt、.md、.fountain 文件。文件只在浏览器里读取。'
          }
          actions={
            onCancel ? (
              <Button variant="ghost" onClick={onCancel} disabled={importer.isPending}>
                取消
              </Button>
            ) : null
          }
        />

        <div
          className={`mt-4 rounded-sheet border border-dashed p-1 transition-colors ${dragOver ? 'border-focus bg-info-bg' : 'border-transparent'}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <TextArea
            aria-label="剧本文本"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'1. 内景 旧书店 夜\n店主整理书架……\n\n也可以把文件拖到这里。'}
            className="min-h-[200px] resize-y font-mono text-[13px]"
            aria-invalid={tooLong || undefined}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field label="来源名称" hint="用于版本列表，例如文件名。">
            {({ id, describedBy }) => (
              <TextInput id={id} aria-describedby={describedBy} value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="粘贴的剧本" maxLength={200} />
            )}
          </Field>
          <Field label="格式">
            {({ id }) => (
              <Select id={id} value={format} onChange={(e) => setFormat(e.target.value as ScriptFormat)}>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {SCRIPT_FORMAT_LABEL[f]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
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
          <Button onClick={() => fileInput.current?.click()} busy={reading}>
            {reading ? null : <FileUp aria-hidden className="size-3.5" />}
            选择文件
          </Button>
          <Button
            variant={result && !stale ? 'secondary' : 'primary'}
            onClick={() => runPreview({ text, overrides, format })}
            disabled={text.trim() === '' || tooLong}
            busy={preview.isPending && !result}
          >
            {preview.isPending && !result ? null : <ScanText aria-hidden className="size-3.5" />}
            {result ? '重新识别场景' : '识别场景'}
          </Button>
          <span className="text-xs text-ink-3 tabular-nums">{text.length.toLocaleString('zh-CN')} 字符</span>
        </div>

        {tooLong ? <p className="mt-2 text-xs text-danger">剧本超过 {MAX_SCRIPT_CHARS.toLocaleString('zh-CN')} 个字符，无法导入。</p> : null}
        {fileError ? <p className="mt-2 text-xs text-danger">{fileError}</p> : null}
        {preview.isError ? <ErrorNotice className="mt-3" error={preview.error} context="script-import" /> : null}
      </section>

      {result ? (
        <section aria-labelledby="preview-title" className="rounded-sheet border border-rule bg-sheet px-4 py-4 sm:px-6 sm:py-5">
          <SectionHeading
            id="preview-title"
            title="场景预览"
            description="点击行首方框，把这一行设为场景标题或取消。右侧是按当前标记切出的场景。"
            actions={preview.isPending ? <Spinner label="更新中…" /> : null}
          />

          {stale ? (
            <Note tone="warn" className="mt-3">
              文本在识别后被修改过。点"重新识别场景"更新预览后才能导入。
            </Note>
          ) : null}

          <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="min-w-0">
              <p className="mb-1.5 text-xs text-ink-3">
                共 {lines.length} 行，规则识别出 {detected.size} 个标题
                {overrides.length > 0 ? `，手动调整 ${overrides.length} 处` : ''}
              </p>
              <ol ref={linesBox} className="max-h-[60vh] overflow-y-auto overscroll-contain rounded-sheet border border-rule bg-sheet-sunk/40 py-1">
                {lines.map((line, i) => {
                  const n = i + 1;
                  if (line.trim() === '') return <li key={n} aria-hidden className="h-2" />;
                  const heading = isHeadingLine(n, detected, overrides);
                  const manual = overrides.some((o) => o.line === n);
                  return (
                    <li key={n} data-line={n} className={`flex items-start gap-2 px-2 py-0.5 [content-visibility:auto] ${heading ? 'bg-sheet' : ''}`}>
                      <button
                        type="button"
                        aria-pressed={heading}
                        onClick={() => toggle(n)}
                        disabled={stale}
                        title={heading ? '取消场景标题' : '设为场景标题'}
                        aria-label={`第 ${n} 行：${heading ? '取消场景标题' : '设为场景标题'}`}
                        className={
                          'mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] border text-[10px] leading-none ' +
                          (heading ? 'border-graphite bg-graphite text-sheet' : 'border-rule-strong bg-sheet text-transparent hover:enabled:border-ink-2 hover:enabled:text-ink-3') +
                          ' disabled:cursor-not-allowed disabled:opacity-50'
                        }
                      >
                        场
                      </button>
                      <span className="w-8 shrink-0 pt-px text-right font-mono text-[11px] text-ink-3 tabular-nums">{n}</span>
                      <span className={`min-w-0 flex-1 text-[13px] break-words whitespace-pre-wrap ${heading ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                        {line}
                      </span>
                      {manual ? (
                        <Tag tone="info" className="mt-px">
                          手动
                        </Tag>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>

            <div className="min-w-0">
              <p className="mb-1.5 text-xs text-ink-3">识别出 {result.scenes.length} 个场景</p>
              {result.scenes.length === 0 ? (
                <Note tone="warn">没有识别出场景标题。点击左侧行首的方框，手动把某一行设为场景标题。</Note>
              ) : (
                <ol className="max-h-[60vh] divide-y divide-rule overflow-y-auto overscroll-contain rounded-sheet border border-rule">
                  {result.scenes.map((s, i) => {
                    const line = lineOf(s.paragraph_ids[0]);
                    return (
                      <li key={`${s.display_no}-${i}`}>
                        <button
                          type="button"
                          onClick={() => (line ? scrollToLine(line) : undefined)}
                          className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-sheet-sunk"
                        >
                          <span className="w-10 shrink-0 font-mono text-xs text-ink-3 tabular-nums">{s.display_no}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium break-words text-ink">{s.heading}</span>
                            <span className="block text-xs text-ink-3">
                              {s.paragraph_ids.length} 段
                              {s.time_label ? ` · ${s.time_label}` : ''}
                              {s.location_label ? ` · ${s.location_label}` : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
              {unassigned > 0 ? <p className="mt-2 text-xs text-ink-3">第一个场景标题之前的 {unassigned} 段不属于任何场景。</p> : null}
            </div>
          </div>

          {importer.isError ? <ErrorNotice className="mt-4" error={importer.error} context="script-import" /> : null}

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-rule pt-4">
            <Button variant="primary" onClick={doImport} busy={importer.isPending} disabled={stale || preview.isPending || result.scenes.length === 0}>
              {importer.isPending ? null : <Upload aria-hidden className="size-3.5" />}
              导入为新版本
            </Button>
            <span className="text-xs text-ink-3">
              {result.scenes.length === 0 ? '至少需要一个场景标题。' : `将创建 ${result.scenes.length} 个场景、${result.paragraphs.length} 个段落锚点。`}
            </span>
          </div>
        </section>
      ) : null}
    </div>
  );
}
