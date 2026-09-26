import { useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Shot } from '@storyscript/contracts';
import { Archive, ArrowDown, ArrowUp, Ban, GripVertical, History, Lock, LockOpen, Pencil, RotateCcw } from 'lucide-react';
import { isRevisionConflict } from '../../lib/errors.ts';
import { ANGLE_LABEL, LENS_LABEL, MOVEMENT_LABEL, QUOTE_MATCH_LABEL, REQUIRED_STATUS_LABEL, SHOT_SIZE_LABEL } from '../../lib/labels.ts';
import { useArchiveShot, useSetRequirement, useUpdateShot } from '../../lib/queries.ts';
import { sourceState } from '../../lib/shots.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Menu, type MenuItem } from '../../components/Menu.tsx';
import { Tag } from '../../components/ui.tsx';
import { useWorkspace } from './context.ts';

function Spec({ shot }: { shot: Shot }) {
  const f = shot.fields;
  const lens = f.focal_mm !== null ? `${Math.round(f.focal_mm)}mm` : LENS_LABEL[f.lens];
  const items = [SHOT_SIZE_LABEL[f.shot_size], ANGLE_LABEL[f.angle], lens, MOVEMENT_LABEL[f.movement]];
  return (
    <span className="flex flex-wrap items-center gap-1">
      {items.map((t, i) => (
        <span key={i} className={`rounded-[2px] px-1 text-[12px] leading-5 ${i === 0 ? 'bg-graphite text-sheet' : 'bg-sheet-sunk text-ink-2'}`}>
          {t}
        </span>
      ))}
    </span>
  );
}

function CodeCell({ shot }: { shot: Shot }) {
  const update = useUpdateShot();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(shot.code);

  const commit = () => {
    const v = value.trim();
    setEditing(false);
    if (v === '' || v === shot.code) {
      setValue(shot.code);
      return;
    }
    update.mutate({ id: shot.id, input: { expected_revision: shot.revision, code: v } }, { onError: () => setValue(shot.code) });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      setValue(shot.code);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        aria-label="镜号"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        maxLength={40}
        className="h-6 w-24 rounded-control border border-focus bg-sheet px-1.5 font-mono text-[12.5px] text-ink"
      />
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          setValue(shot.code);
          setEditing(true);
        }}
        disabled={shot.archived || update.isPending}
        className="rounded-control px-1 font-mono text-[12.5px] font-semibold text-ink hover:enabled:bg-sheet-sunk disabled:cursor-default"
        title={shot.archived ? undefined : '点击修改镜号（只是显示编号）'}
      >
        {update.isPending ? value : shot.code}
      </button>
      {update.isError ? (
        <span className="text-xs text-danger" title={isRevisionConflict(update.error) ? '镜头已在别处修改，请刷新后重试' : '保存失败'}>
          {isRevisionConflict(update.error) ? '冲突' : '未保存'}
        </span>
      ) : null}
    </span>
  );
}

function SourceCell({ shot }: { shot: Shot }) {
  const ws = useWorkspace();
  const s = sourceState(shot);
  const locateBtn = (pid: string, quote: string | null, label: string) => (
    <button
      type="button"
      onClick={() => ws.locate(shot.source_anchor ? { ...shot.source_anchor, quote: quote ?? '' } : { paragraph_id: pid, quote: quote ?? '' })}
      className="inline-flex h-5 items-center rounded-control border border-rule px-1.5 font-mono text-[11px] text-ink-2 hover:border-rule-strong hover:text-ink"
      title={quote ? `定位原文：${quote}` : '定位原文'}
    >
      {label}
    </button>
  );
  switch (s.kind) {
    case 'relink':
      return (
        <button type="button" onClick={() => ws.openEditor(shot)} title="剧本改版后原引用找不到了，点击重新选择段落和引用">
          <Tag tone="warn">待重新关联</Tag>
        </button>
      );
    case 'manual':
      return (
        <span className="inline-flex items-center gap-1">
          <Tag tone="neutral" title={shot.manual_note ?? undefined}>
            手工
          </Tag>
          {s.paragraphId ? locateBtn(s.paragraphId, s.quote, s.paragraphId) : null}
        </span>
      );
    case 'anchored':
      return (
        <span className="inline-flex items-center gap-1">
          {locateBtn(s.paragraphId, s.quote, s.paragraphId)}
          {s.match === 'fuzzy' ? <Tag tone="warn">{QUOTE_MATCH_LABEL.fuzzy}</Tag> : null}
        </span>
      );
    default:
      return <span className="text-xs text-ink-3">无出处</span>;
  }
}

export interface ShotRowProps {
  shot: Shot;
  index: number;
  count: number;
  reorderable: boolean;
  dropTarget: boolean;
  onMove: (from: number, to: number) => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

export function ShotRow({ shot, index, count, reorderable, dropTarget, onMove, onDragStart, onDragOver, onDrop, onDragEnd }: ShotRowProps) {
  const ws = useWorkspace();
  const update = useUpdateShot();
  const archive = useArchiveShot();
  const requirement = useSetRequirement();
  const f = shot.fields;
  const waived = shot.required_status === 'waived';

  const setReq = (status: Shot['required_status'], title: string, initial: string) =>
    ws.askReason({
      title,
      description: `${shot.code} · ${f.action || f.narrative_purpose || '（无动作描述）'}`,
      label: '原因',
      initial,
      placeholder: status === 'waived' ? '例如：场地取消，改用插入镜头交代' : undefined,
      confirmLabel: title,
      run: (reason) => requirement.mutateAsync({ id: shot.id, input: { expected_revision: shot.revision, required_status: status, reason } }),
    });

  const items: (MenuItem | 'separator')[] = shot.archived
    ? [{ key: 'history', label: '修订历史', icon: <History className="size-3.5" />, onSelect: () => ws.openRevisions(shot) }]
    : [
        {
          key: 'edit',
          label: '编辑',
          icon: <Pencil className="size-3.5" />,
          onSelect: () => ws.openEditor(shot),
          disabled: shot.locked,
          hint: shot.locked ? '镜头已锁定，先解锁' : undefined,
        },
        {
          key: 'lock',
          label: shot.locked ? '解锁' : '锁定',
          icon: shot.locked ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />,
          onSelect: () => update.mutate({ id: shot.id, input: { expected_revision: shot.revision, locked: !shot.locked } }),
        },
        'separator',
        shot.required_status === 'required'
          ? { key: 'optional', label: '设为可选', onSelect: () => setReq('optional', '设为可选', '可拍可不拍') }
          : shot.required_status === 'optional'
            ? { key: 'required', label: '设为必拍', onSelect: () => setReq('required', '设为必拍', '恢复为必拍') }
            : { key: 'restore', label: '恢复拍摄', icon: <RotateCcw className="size-3.5" />, onSelect: () => setReq('required', '恢复拍摄', '恢复拍摄') },
        ...(waived ? [] : [{ key: 'waive', label: '取消拍摄…', icon: <Ban className="size-3.5" />, onSelect: () => setReq('waived', '取消拍摄', '') }]),
        {
          key: 'archive',
          label: '归档…',
          icon: <Archive className="size-3.5" />,
          danger: true,
          disabled: shot.locked,
          hint: shot.locked ? '镜头已锁定，先解锁' : undefined,
          onSelect: () =>
            ws.askReason({
              title: '归档镜头',
              description: `${shot.code} 会从镜头表中移除（修订历史保留）。`,
              label: '归档原因',
              confirmLabel: '归档',
              danger: true,
              run: (reason) => archive.mutateAsync({ id: shot.id, input: { expected_revision: shot.revision, reason } }),
            }),
        },
        'separator',
        { key: 'history', label: '修订历史', icon: <History className="size-3.5" />, onSelect: () => ws.openRevisions(shot) },
      ];

  const dragProps = reorderable
    ? {
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onDragOver(index);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          onDrop(index);
        },
      }
    : {};

  return (
    <li
      {...dragProps}
      className={
        'relative grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 px-2 py-2 ' +
        (shot.archived ? 'opacity-60 ' : '') +
        (dropTarget ? 'before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:bg-focus ' : '')
      }
    >
      <div className="flex flex-col items-center gap-0.5 pt-0.5">
        {reorderable ? (
          <>
            <span
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', shot.id);
                const row = (e.currentTarget as HTMLElement).closest('li');
                if (row) e.dataTransfer.setDragImage(row, 16, 16);
                onDragStart(index);
              }}
              onDragEnd={onDragEnd}
              className="inline-flex size-6 cursor-grab items-center justify-center rounded-control text-ink-3 hover:bg-sheet-sunk hover:text-ink active:cursor-grabbing"
              title="拖动调整叙事顺序"
              aria-hidden
            >
              <GripVertical className="size-3.5" />
            </span>
            <button
              type="button"
              onClick={() => onMove(index, index - 1)}
              disabled={index === 0}
              className="inline-flex size-6 items-center justify-center rounded-control text-ink-3 hover:enabled:bg-sheet-sunk hover:enabled:text-ink disabled:opacity-30"
              aria-label={`${shot.code} 上移`}
            >
              <ArrowUp aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onMove(index, index + 1)}
              disabled={index === count - 1}
              className="inline-flex size-6 items-center justify-center rounded-control text-ink-3 hover:enabled:bg-sheet-sunk hover:enabled:text-ink disabled:opacity-30"
              aria-label={`${shot.code} 下移`}
            >
              <ArrowDown aria-hidden className="size-3.5" />
            </button>
          </>
        ) : (
          <span className="w-6 pt-0.5 text-center font-mono text-[11px] text-ink-3 tabular-nums">{index + 1}</span>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CodeCell key={shot.code} shot={shot} />
          <Spec shot={shot} />
          {f.est_seconds ? <span className="text-xs text-ink-3 tabular-nums">{f.est_seconds} 秒</span> : null}
        </div>
        <p className={`mt-1 text-[13px] break-words text-ink ${waived ? 'line-through decoration-ink-3' : ''}`}>{f.action || <span className="text-ink-3">（未填写动作）</span>}</p>
        {f.narrative_purpose ? <p className="text-xs break-words text-ink-3">{f.narrative_purpose}</p> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <SourceCell shot={shot} />
          {shot.origin === 'ai' ? <Tag tone="info">AI</Tag> : null}
          {shot.required_status !== 'required' ? (
            <Tag tone={waived ? 'danger' : 'neutral'} title={shot.requirement_reason ?? undefined}>
              {REQUIRED_STATUS_LABEL[shot.required_status]}
            </Tag>
          ) : null}
          {shot.archived ? <Tag tone="neutral">已归档</Tag> : null}
          {f.questions.length > 0 ? (
            <Tag tone="warn" title={f.questions.join('\n')}>
              {f.questions.length} 个待确认问题
            </Tag>
          ) : null}
          {shot.requirement_reason && shot.required_status !== 'required' ? (
            <span className="min-w-0 truncate text-xs text-ink-3" title={shot.requirement_reason}>
              原因：{shot.requirement_reason}
            </span>
          ) : null}
        </div>
        {update.isError ? <ErrorNotice className="mt-2" error={update.error} context="shot-save" /> : null}
      </div>

      <div className="flex items-start gap-0.5">
        {shot.archived ? null : (
          <button
            type="button"
            aria-pressed={shot.locked}
            onClick={() => update.mutate({ id: shot.id, input: { expected_revision: shot.revision, locked: !shot.locked } })}
            disabled={update.isPending}
            className={`inline-flex size-7 items-center justify-center rounded-control ${shot.locked ? 'bg-graphite text-sheet' : 'text-ink-3 hover:bg-sheet-sunk hover:text-ink'}`}
            title={shot.locked ? '已锁定：AI 重新拆镜不会改动它。点击解锁' : '锁定后，AI 重新拆镜不会改动这个镜头'}
            aria-label={shot.locked ? `解锁 ${shot.code}` : `锁定 ${shot.code}`}
          >
            {shot.locked ? <Lock aria-hidden className="size-3.5" /> : <LockOpen aria-hidden className="size-3.5" />}
          </button>
        )}
        <Menu label={`${shot.code} 的操作`} items={items} />
      </div>
    </li>
  );
}
