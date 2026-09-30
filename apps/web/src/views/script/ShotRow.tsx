import { memo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Shot } from '@storyscript/contracts';
import { Archive, ArrowDown, ArrowUp, Ban, GripVertical, History, Lock, LockOpen, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import { isRevisionConflict } from '../../lib/errors.ts';
import { ANGLE_LABEL, LENS_LABEL, MOVEMENT_LABEL, QUOTE_MATCH_LABEL, REQUIRED_STATUS_LABEL, SHOT_SIZE_LABEL } from '../../lib/labels.ts';
import { polishAiReason } from '../../lib/polish.ts';
import { useArchiveShot, useSetRequirement, useUpdateShot } from '../../lib/queries.ts';
import { sourceState } from '../../lib/shots.ts';
import { CommentBadge } from '../../components/CommentsPanel.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Menu, type MenuItem } from '../../components/Menu.tsx';
import { Tag } from '../../components/ui.tsx';
import { setCommentsFocus } from '../../lib/open-shot.ts';
import { shotRowDomId, useWorkspace } from './context.ts';

function Spec({ shot }: { shot: Shot }) {
  const f = shot.fields;
  const lens = f.focal_mm !== null ? `${Math.round(f.focal_mm)}mm` : LENS_LABEL[f.lens];
  return (
    <span className="min-w-0 truncate text-xs text-graphite-300">
      <span className="font-medium text-graphite-100">{SHOT_SIZE_LABEL[f.shot_size]}</span>
      {` · ${ANGLE_LABEL[f.angle]} · ${lens} · ${MOVEMENT_LABEL[f.movement]}`}
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
        aria-label={`镜号 ${shot.code}`}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        maxLength={40}
        className="h-6 w-20 rounded-control border border-accent bg-graphite-800 px-1.5 text-sm font-medium text-graphite-100 tabular-nums"
      />
    );
  }
  const locked = shot.locked;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => {
          setValue(shot.code);
          setEditing(true);
        }}
        disabled={locked || update.isPending}
        className="h-6 rounded-control px-1 text-sm font-medium text-graphite-100 tabular-nums hover:enabled:bg-graphite-700 disabled:cursor-default"
        title={locked ? '镜头已锁定' : '点击修改镜号（只是显示编号，不影响身份）'}
        aria-label={`镜号 ${shot.code}${locked ? '' : '，点击修改'}`}
      >
        {update.isPending ? value : shot.code}
      </button>
      {update.isError ? (
        <span className="text-xs text-graphite-100" title={isRevisionConflict(update.error) ? '镜头已在别处修改，请刷新后重试' : '保存失败'}>
          <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full bg-danger" />
          {isRevisionConflict(update.error) ? '冲突' : '未保存'}
        </span>
      ) : null}
    </span>
  );
}

function SourceCell({ shot }: { shot: Shot }) {
  const ws = useWorkspace();
  const s = sourceState(shot);
  const locateBtn = (pid: string, quote: string | null) => (
    <button
      type="button"
      onClick={() => ws.locate(shot.source_anchor ? { ...shot.source_anchor, quote: quote ?? '' } : { paragraph_id: pid, quote: quote ?? '' })}
      className="inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-control border border-graphite-700 px-1.5 text-xs text-graphite-300 hover:border-graphite-500 hover:text-graphite-100"
      title={quote ? `定位原文：${quote}` : '定位原文'}
    >
      <span className="shrink-0 tabular-nums">{pid}</span>
      {quote ? <span className="min-w-0 truncate">「{quote}」</span> : null}
    </button>
  );
  switch (s.kind) {
    case 'relink':
      return (
        <button type="button" onClick={() => ws.selectShot(shot)} title="剧本改版后原引用找不到了：在检查器里重新选择段落和引用原文">
          <Tag tone="warn">待重新关联</Tag>
        </button>
      );
    case 'manual':
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          <Tag title={shot.manual_note ? `手工镜头：${shot.manual_note}` : '手工镜头'}>手工</Tag>
          {s.paragraphId ? locateBtn(s.paragraphId, s.quote) : null}
        </span>
      );
    case 'anchored':
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          {locateBtn(s.paragraphId, s.quote)}
          {s.match === 'fuzzy' ? <Tag tone="warn">{QUOTE_MATCH_LABEL.fuzzy}</Tag> : null}
        </span>
      );
    default:
      return <span className="text-xs text-graphite-300">无出处</span>;
  }
}

export interface ShotRowProps {
  shot: Shot;
  index: number;
  count: number;
  selected: boolean;
  reorderable: boolean;
  dropTarget: boolean;
  onMove: (from: number, to: number) => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

export const ShotRow = memo(function ShotRow({
  shot,
  index,
  count,
  selected,
  reorderable,
  dropTarget,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ShotRowProps) {
  const ws = useWorkspace();
  const update = useUpdateShot();
  const archive = useArchiveShot();
  const requirement = useSetRequirement();
  const f = shot.fields;
  const waived = shot.required_status === 'waived';
  const summary = f.action || f.narrative_purpose || '（未填写动作）';

  const setReq = (status: Shot['required_status'], title: string, initial: string) =>
    ws.askReason({
      title,
      description: `${shot.code} · ${summary}`,
      label: '原因',
      initial,
      placeholder: status === 'waived' ? '例如：场地取消，改用插入镜头交代' : undefined,
      confirmLabel: title,
      run: (reason) => requirement.mutateAsync({ id: shot.id, input: { expected_revision: shot.revision, required_status: status, reason } }),
    });

  const toggleLock = () => update.mutate({ id: shot.id, input: { expected_revision: shot.revision, locked: !shot.locked } });

  // S3a: 选择 mode ticks rows; a locked shot is never polished
  const ticked = ws.selected.has(shot.id);
  const polishBlocked = shot.locked ? '镜头已锁定，先解锁再润色' : (polishAiReason(ws.ai) ?? undefined);

  const items: (MenuItem | 'separator')[] = [
    {
      key: 'edit',
      label: shot.locked ? '查看' : '编辑',
      icon: <Pencil className="size-3.5" />,
      onSelect: () => ws.selectShot(shot),
    },
    {
      key: 'polish',
      label: 'AI 润色…',
      icon: <Sparkles className="size-3.5" />,
      disabled: polishBlocked !== undefined,
      hint: polishBlocked ?? '让模型按方式和风格重写这个镜头，结果先进草案',
      onSelect: () => ws.openPolish([shot.id]),
    },
    {
      key: 'lock',
      label: shot.locked ? '解锁' : '锁定',
      icon: shot.locked ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />,
      onSelect: toggleLock,
    },
    'separator',
    shot.required_status === 'required'
      ? { key: 'optional', label: '设为可选…', onSelect: () => setReq('optional', '设为可选', '可拍可不拍') }
      : shot.required_status === 'optional'
        ? { key: 'required', label: '设为必拍…', onSelect: () => setReq('required', '设为必拍', '恢复为必拍') }
        : { key: 'restore', label: '恢复拍摄…', icon: <RotateCcw className="size-3.5" />, onSelect: () => setReq('required', '恢复拍摄', '恢复拍摄') },
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
          description: `${shot.code} 会从镜头表中移除，修订历史保留。`,
          label: '归档原因',
          confirmLabel: '归档',
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

  // Clicking the row body selects the shot; its own controls keep their meaning.
  const onRowClick = (e: MouseEvent<HTMLLIElement>) => {
    if ((e.target as HTMLElement).closest('button, input, label, a, [role="menu"]')) return;
    ws.selectShot(shot);
  };

  const moveBtn = 'inline-flex h-5 w-6 items-center justify-center rounded-control text-graphite-300 hover:enabled:bg-graphite-700 hover:enabled:text-graphite-100 disabled:opacity-30';

  return (
    <li
      id={shotRowDomId(shot.id)}
      {...dragProps}
      onClick={onRowClick}
      className={
        'group relative grid scroll-my-12 grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-2 py-2 pr-1 pl-2 ' +
        (selected ? 'bg-graphite-800 ' : 'hover:bg-graphite-800/50 ') +
        (dropTarget ? 'before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:bg-graphite-100 ' : '')
      }
    >
      {selected ? <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" /> : null}
      <div className="flex flex-col items-center">
        {ws.selecting ? (
          <label
            className={`inline-flex size-6 items-center justify-center rounded-control ${shot.locked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-graphite-700'}`}
            title={shot.locked ? '镜头已锁定，不能润色' : undefined}
          >
            <input
              type="checkbox"
              checked={ticked}
              disabled={shot.locked}
              onChange={() => ws.toggleSelect(shot.id)}
              aria-label={`选择镜头 ${shot.code}`}
              className="size-3.5 accent-graphite-100 disabled:cursor-not-allowed disabled:opacity-40"
            />
          </label>
        ) : null}
        {reorderable ? (
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
            className="relative inline-flex size-6 cursor-grab items-center justify-center rounded-control text-xs text-graphite-300 tabular-nums hover:bg-graphite-700 active:cursor-grabbing"
            title="拖动调整叙事顺序"
          >
            <span className="group-hover:invisible">{index + 1}</span>
            <GripVertical aria-hidden className="invisible absolute size-3.5 group-hover:visible" />
          </span>
        ) : (
          <span className="h-6 text-xs leading-6 text-graphite-300 tabular-nums">{index + 1}</span>
        )}
        {reorderable ? (
          <div className={`flex flex-col items-center ${selected ? '' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`}>
            <button type="button" onClick={() => onMove(index, index - 1)} disabled={index === 0} className={moveBtn} aria-label={`${shot.code} 上移`} title="上移（叙事顺序）">
              <ArrowUp aria-hidden className="size-3" />
            </button>
            <button type="button" onClick={() => onMove(index, index + 1)} disabled={index === count - 1} className={moveBtn} aria-label={`${shot.code} 下移`} title="下移（叙事顺序）">
              <ArrowDown aria-hidden className="size-3" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <CodeCell key={shot.code} shot={shot} />
          <Spec shot={shot} />
          <span className="ml-auto shrink-0 text-xs text-graphite-300 tabular-nums">{Number.isFinite(f.est_seconds) ? `${f.est_seconds} 秒` : ''}</span>
        </div>
        <button
          type="button"
          data-shot-summary=""
          onClick={() => ws.selectShot(shot)}
          aria-current={selected ? 'true' : undefined}
          className={`mt-0.5 block w-full text-left text-sm break-words text-graphite-100 [display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2] ${waived ? 'line-through decoration-graphite-300' : ''}`}
          title={f.narrative_purpose ? `叙事作用：${f.narrative_purpose}` : undefined}
        >
          {f.action || <span className="text-graphite-300">{summary}</span>}
        </button>
        {typeof f.camera_notes === 'string' && f.camera_notes.trim() !== '' ? (
          <p data-shot-camera-notes="" className="mt-0.5 truncate text-xs text-graphite-300" title={f.camera_notes}>
            拍法：{f.camera_notes}
          </p>
        ) : null}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          {shot.origin === 'ai' ? <Tag>AI</Tag> : null}
          {shot.required_status !== 'required' ? (
            <Tag tone={waived ? 'danger' : 'neutral'} title={shot.requirement_reason ? `原因：${shot.requirement_reason}` : undefined}>
              {REQUIRED_STATUS_LABEL[shot.required_status]}
            </Tag>
          ) : null}
          {f.questions.length > 0 ? (
            <Tag tone="warn" title={f.questions.join('\n')}>
              {f.questions.length} 个待确认
            </Tag>
          ) : null}
          <SourceCell shot={shot} />
          {/* S4b: comments on this shot (hosted server; renders nothing without any) */}
          <CommentBadge
            shotId={shot.id}
            label={`${shot.code} 的批注`}
            onOpen={() => {
              setCommentsFocus({ shotId: shot.id });
              ws.selectShot(shot);
            }}
          />
        </div>
        {update.isError ? <ErrorNotice className="mt-2" error={update.error} context="shot-save" /> : null}
      </div>

      <div className="flex items-start gap-0.5">
        <button
          type="button"
          aria-pressed={shot.locked}
          onClick={toggleLock}
          disabled={update.isPending}
          className={
            'inline-flex size-6 items-center justify-center rounded-control ' +
            (shot.locked ? 'bg-graphite-100 text-graphite-950 hover:bg-graphite-100/85' : 'text-graphite-300 hover:bg-graphite-700 hover:text-graphite-100')
          }
          title={shot.locked ? '已锁定：AI 重新拆镜不会改动它。点击解锁' : '锁定后，AI 重新拆镜不会改动这个镜头'}
          aria-label={shot.locked ? `解锁 ${shot.code}` : `锁定 ${shot.code}`}
        >
          {shot.locked ? <Lock aria-hidden className="size-3.5" /> : <LockOpen aria-hidden className="size-3.5" />}
        </button>
        <Menu label={`${shot.code} 的操作`} items={items} />
      </div>
    </li>
  );
});
