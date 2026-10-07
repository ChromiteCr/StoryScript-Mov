import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { PASTE_MAX_CHARS, PASTE_MAX_SEGMENTS, type PasteHint, type PasteItem, type PasteItemView, type PasteKind, type PasteNoteSummary, type PasteNoteView } from '@storyscript/contracts';
import { cleanPasteText, PASTE_SAMPLE, PASTE_SAMPLE_DATE, splitPaste } from '@storyscript/core';
import { ClipboardPaste, LoaderCircle, Plus, RotateCcw } from 'lucide-react';
import { hostOf } from '../views/TextProviderPanel.tsx';
import { todayIn } from '../views/plan/data.ts';
import { NAMED_KINDS, PASTE_HINT_LABEL, PASTE_KIND_LABEL, appliedLine, defaultSelection, groupItems, itemSummary, pruneSelection, resolutionText } from '../lib/paste.ts';
import { closePasteDialog, useApplyPaste, useClosePaste, useCreatePaste, usePasteNote, usePasteNotes, usePasteOpen, useRetryPasteSegment } from '../lib/queries-paste.ts';
import { useAiGate, useCurrentProject, useHealth, useProviders } from '../lib/queries.ts';
import { useMediaQuery, WIDE_QUERY } from '../lib/useMediaQuery.ts';
import { ActorLabel } from './ActorLabel.tsx';
import { Dialog } from './Dialog.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Button, Field, Notice, SelectInput, Spinner, Tag, TextArea, TextInput } from './ui.tsx';

/**
 * S5a 粘贴整理: paste a group chat (or notes, a roster), the model sorts it
 * into kinds, a person ticks what to keep and applies it to the plan, the
 * set, the script's props and the todo list. Opens from the page bar and the
 * plan / set pages; earlier pastes stay in the list until closed.
 */

export function PasteDialog() {
  const { open, hint, noteId } = usePasteOpen();
  if (!open) return null;
  return <PasteDialogBody hint={hint} initialNote={noteId} />;
}

function PasteDialogBody({ hint, initialNote }: { hint: PasteHint; initialNote: string | null }) {
  const [noteId, setNoteId] = useState<string | null>(initialNote);
  const notes = usePasteNotes();
  const wide = useMediaQuery(WIDE_QUERY);
  const apply = useApplyPaste();

  return (
    <Dialog
      variant="full"
      title="粘贴整理"
      onClose={closePasteDialog}
      busy={apply.isPending}
      description="把群聊、备忘录或排班表里的文字贴进来，模型按类别整理成草稿；勾选后才写进计划、现场、道具和待办。"
      bodyClassName="flex min-h-0 flex-col lg:flex-row"
    >
      {wide ? (
        <aside aria-label="最近的整理" className="flex w-[260px] shrink-0 flex-col border-r border-graphite-800">
          <NotesList notes={notes.data ?? []} current={noteId} onPick={setNoteId} />
        </aside>
      ) : (
        <div className="shrink-0 border-b border-graphite-800 px-4 py-2">
          <SelectInput aria-label="选择一次整理" value={noteId ?? ''} onChange={(e) => setNoteId(e.target.value || null)}>
            <option value="">新的整理</option>
            {(notes.data ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                {n.ref_date} · {n.title}
              </option>
            ))}
          </SelectInput>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {noteId ? <NoteReview key={noteId} id={noteId} apply={apply} /> : <PasteForm initialHint={hint} onCreated={setNoteId} />}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ the list

function noteState(n: PasteNoteSummary): string {
  if (n.pending_segments > 0) return '整理中';
  if (n.closed) return '已收起';
  if (n.item_count === 0) return '没有条目';
  return n.applied_count >= n.item_count ? '已全部应用' : `已应用 ${n.applied_count}/${n.item_count}`;
}

function NotesList({ notes, current, onPick }: { notes: readonly PasteNoteSummary[]; current: string | null; onPick: (id: string | null) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <Button className="w-full justify-center" variant={current === null ? 'primary' : 'secondary'} onClick={() => onPick(null)}>
          <Plus aria-hidden className="size-3.5" />
          新的整理
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto pb-2">
        {notes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              aria-current={n.id === current ? 'true' : undefined}
              onClick={() => onPick(n.id)}
              className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left focus-visible:outline-offset-[-2px] ${n.id === current ? 'bg-graphite-800' : 'hover:bg-graphite-800/60'} ${n.closed ? 'opacity-70' : ''}`}
            >
              <span className="truncate text-sm text-graphite-100">{n.title || '（空）'}</span>
              <span className="flex flex-wrap items-center gap-x-2 text-xs text-graphite-300 tabular-nums">
                <span>{n.ref_date}</span>
                <span>{noteState(n)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ the form

const HINTS: readonly PasteHint[] = ['auto', 'plan', 'set'];

function PasteForm({ initialHint, onCreated }: { initialHint: PasteHint; onCreated: (id: string) => void }) {
  const project = useCurrentProject().data;
  const health = useHealth().data;
  const gate = useAiGate();
  const providers = useProviders();
  const create = useCreatePaste();
  const [text, setText] = useState('');
  const [date, setDate] = useState(() => (project ? todayIn(project.timezone) : new Date().toISOString().slice(0, 10)));
  const [hint, setHint] = useState<PasteHint>(initialHint);
  const [confirming, setConfirming] = useState(false);
  const clean = useMemo(() => cleanPasteText(text), [text]);
  const segments = useMemo(() => splitPaste(clean).length, [clean]);
  const chars = Array.from(text).length;
  const host = gate.demo ? '演示回放（不外发）' : hostOf(providers.data?.text?.base_url);
  const groupKey = health?.hosted && health.text_model_source !== 'own';
  const tooLong = chars > PASTE_MAX_CHARS || segments > PASTE_MAX_SEGMENTS;
  const cannot =
    gate.reason ??
    (clean.length === 0
      ? '先贴入要整理的文字'
      : chars > PASTE_MAX_CHARS
        ? `最多 ${PASTE_MAX_CHARS.toLocaleString('zh-CN')} 字`
        : tooLong
          ? `最多分 ${PASTE_MAX_SEGMENTS} 段（每段约 3000 字）`
          : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cannot) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    create.mutate({ text: clean, ref_date: date, hint }, { onSuccess: (note) => onCreated(note.id) });
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4" noValidate>
      <Field label="要整理的文字" hint={<span className="tabular-nums">{chars.toLocaleString('zh-CN')}/{PASTE_MAX_CHARS.toLocaleString('zh-CN')} 字{segments > 1 ? `，分 ${segments} 段` : ''}</span>}>
        {({ id, describedBy }) => (
          <TextArea
            id={id}
            aria-describedby={describedBy}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setConfirming(false);
            }}
            rows={12}
            placeholder={'例如：\n[20:13] 小雨：我周六上午有课，下午 2 点以后可以\n[20:20] 小林（摄影）：稳定器我带\n[20:21] 阿杰（导演）：第 2 场放周日上午拍'}
            className="min-h-[220px] font-[inherit]"
          />
        )}
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <Field label="这些消息的日期" hint="用来换算「周六下午」「下周一」">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setConfirming(false);
              }}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-graphite-300">内容多半是</span>
          <div role="group" aria-label="内容多半是" className="flex gap-1">
            {HINTS.map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={hint === h}
                onClick={() => setHint(h)}
                className={
                  'h-8 flex-1 rounded-control border px-2 text-sm ' +
                  (hint === h ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950' : 'border-graphite-700 text-graphite-300 hover:text-graphite-100')
                }
              >
                {PASTE_HINT_LABEL[h]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {gate.demo ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-graphite-300">
          <Button
            size="sm"
            onClick={() => {
              setText(PASTE_SAMPLE);
              setDate(PASTE_SAMPLE_DATE);
              setConfirming(false);
            }}
          >
            填入示例
          </Button>
          演示模式只能回放这段录好的示例群聊。
        </div>
      ) : null}
      {confirming && !cannot ? (
        <Notice tone="info" title={`将分 ${segments} 段发送到 ${host ?? '你配置的地址'}`} role="status">
          粘贴的内容会发给本组配置的模型服务，请先删掉不想外发的信息。每段 1 次调用，输出格式不对时最多再试 2 次{groupKey ? `；用本组的 key，计入每日上限（这次算 ${segments} 次）` : ''}。整理结果先作为草稿，勾选后才写入。
        </Notice>
      ) : null}
      {create.isError ? <ErrorNotice error={create.error} context="ai-request" /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={create.isPending} disabled={cannot !== null} title={cannot ?? undefined}>
          {create.isPending ? null : <ClipboardPaste aria-hidden className="size-3.5" />}
          {confirming ? '确认发送' : '整理'}
        </Button>
        {confirming ? (
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            再改改
          </Button>
        ) : null}
        {cannot && chars > 0 ? <span className="text-xs text-graphite-300">{cannot}</span> : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the review

function NoteReview({ id, apply }: { id: string; apply: ReturnType<typeof useApplyPaste> }) {
  const note = usePasteNote(id);
  const close = useClosePaste();
  const retry = useRetryPasteSegment();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [edits, setEdits] = useState<Record<string, PasteItem>>({});
  const seen = useRef(new Set<string>());
  const [result, setResult] = useState<string | null>(null);
  const data = note.data;

  // new items (a segment just finished) join the selection if suggested; gone or applied ones leave it
  useEffect(() => {
    if (!data) return;
    setSelected((cur) => {
      const next = pruneSelection(cur, data.items);
      for (const k of defaultSelection(data.items)) if (!seen.current.has(k)) next.add(k);
      for (const i of data.items) seen.current.add(i.key);
      return next;
    });
  }, [data]);

  if (note.isPending) {
    return (
      <div className="p-4">
        <Spinner label="正在读取…" />
      </div>
    );
  }
  if (note.isError || !data) {
    return (
      <div className="p-4">
        <ErrorNotice error={note.error} />
      </div>
    );
  }

  const groups = groupItems(data.items);
  const picked = data.items.filter((i) => selected.has(i.key));
  const doApply = () => {
    setResult(null);
    apply.mutate(
      { id, input: { items: picked.map((i) => ({ key: i.key, item: edits[i.key] ?? i.item })) } },
      {
        onSuccess: (res) => {
          setResult(appliedLine(res.counts));
          setEdits((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !picked.some((p) => p.key === k))));
        },
      },
    );
  };
  const toggle = (key: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-4 py-4">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-graphite-300 tabular-nums">
          <span>消息日期 {data.ref_date}</span>
          <span>{data.chars.toLocaleString('zh-CN')} 字，{data.segments} 段</span>
          <span>{PASTE_HINT_LABEL[data.hint]}</span>
          <ActorLabel actor={data.actor} after="发起" />
          {data.closed ? <Tag>已收起</Tag> : null}
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {data.segment_views.map((s) =>
            s.status === 'pending' ? (
              <p key={s.idx} role="status" className="inline-flex items-center gap-2 text-sm text-graphite-300">
                <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
                {data.segments > 1 ? `第 ${s.idx + 1}/${data.segments} 段整理中…` : '整理中…'}
              </p>
            ) : s.status === 'failed' ? (
              <Notice key={s.idx} tone="warn" title={`${data.segments > 1 ? `第 ${s.idx + 1} 段` : '这次'}没有整理出来`}>
                <span className="block">{s.error?.message ?? '模型没有给出可用的结果。'}</span>
                <Button className="mt-2" size="sm" busy={retry.isPending} onClick={() => retry.mutate({ id, idx: s.idx })}>
                  <RotateCcw aria-hidden className="size-3.5" />
                  重试这一段
                </Button>
              </Notice>
            ) : s.issues.length ? (
              <Notice key={s.idx} tone="info" title={data.segments > 1 ? `第 ${s.idx + 1} 段的附注` : '附注'}>
                {s.issues.map((i) => i.message).join('；')}
              </Notice>
            ) : null,
          )}
          {retry.isError ? <ErrorNotice error={retry.error} context="ai-request" /> : null}
        </div>

        {groups.map((g) => (
          <KindSection key={g.kind} kind={g.kind} items={g.items} selected={selected} edits={edits} refDate={data.ref_date} onToggle={toggle} onEdit={(k, it) => setEdits((cur) => ({ ...cur, [k]: it }))} />
        ))}
        {data.items.length === 0 && data.pending_segments === 0 ? <p className="mt-4 text-sm text-graphite-300">没有整理出条目。</p> : null}

        <Uncovered lines={data.segment_views.flatMap((s) => s.uncovered)} />
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-graphite-800 bg-graphite-900 px-4 py-2.5">
        {result ? (
          <span role="status" className="min-w-0 text-sm text-graphite-100">
            {result}
          </span>
        ) : null}
        {apply.isError ? <ErrorNotice className="w-full" error={apply.error} /> : null}
        <span className="ml-auto flex items-center gap-2">
          {!data.closed ? (
            <Button variant="ghost" busy={close.isPending} onClick={() => close.mutate(id)} title="收起后仍可在列表里找到">
              收起这次整理
            </Button>
          ) : null}
          <Button variant="primary" busy={apply.isPending} disabled={picked.length === 0} onClick={doApply}>
            应用所选（{picked.length} 条）
          </Button>
        </span>
      </footer>
    </>
  );
}

function KindSection({
  kind,
  items,
  selected,
  edits,
  refDate,
  onToggle,
  onEdit,
}: {
  kind: PasteKind;
  refDate: string;
  items: readonly PasteItemView[];
  selected: ReadonlySet<string>;
  edits: Readonly<Record<string, PasteItem>>;
  onToggle: (key: string, on: boolean) => void;
  onEdit: (key: string, item: PasteItem) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-5">
      <h3 id={headingId} className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-graphite-100">
        {PASTE_KIND_LABEL[kind]}
        <span className="text-xs font-normal text-graphite-300 tabular-nums">{items.length}</span>
      </h3>
      <ul className="flex flex-col gap-2">
        {items.map((v) => (
          <ItemRow key={v.key} view={v} edited={edits[v.key] ?? null} checked={selected.has(v.key)} refDate={refDate} onToggle={onToggle} onEdit={onEdit} />
        ))}
      </ul>
    </section>
  );
}

function ItemRow({
  view,
  edited,
  checked,
  refDate,
  onToggle,
  onEdit,
}: {
  view: PasteItemView;
  refDate: string;
  edited: PasteItem | null;
  checked: boolean;
  onToggle: (key: string, on: boolean) => void;
  onEdit: (key: string, item: PasteItem) => void;
}) {
  const boxId = useId();
  const [editing, setEditing] = useState(false);
  const item = edited ?? view.item;
  const locked = view.applied !== null || view.blocked !== null;
  const how = resolutionText({ item: view.item, resolution: view.resolution });

  return (
    <li className={`rounded-panel border border-graphite-700 px-3 py-2.5 ${view.applied ? 'bg-transparent opacity-80' : 'bg-graphite-800/50'}`}>
      <div className="flex items-start gap-2.5">
        <input
          id={boxId}
          type="checkbox"
          checked={checked && !locked}
          disabled={locked}
          onChange={(e) => onToggle(view.key, e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-graphite-100"
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={boxId} className="block cursor-pointer text-sm leading-6 break-words text-graphite-100">
            {itemSummary(item)}
          </label>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-graphite-300">
            {view.applied ? <ActorLabel actor={view.applied.actor} after="已应用" /> : null}
            {view.applied && !view.applied.actor ? <span>已应用</span> : null}
            {!view.applied && how && !edited ? <span>{how}</span> : null}
            {edited ? <span>改过的内容在应用时重新对照（合并还是新建、需不需要确认）</span> : null}
            {view.unconfirmed && !edited ? <Tag tone="warn">需确认</Tag> : null}
            {edited ? <Tag>已修改</Tag> : null}
          </p>
          {view.blocked && !view.applied ? <p className="mt-1 text-xs text-graphite-100">不能应用：{view.blocked}</p> : null}
          {view.warnings.length && !edited ? (
            <ul className="mt-1 list-disc pl-4 text-xs leading-5 text-graphite-300">
              {view.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs break-words text-graphite-300">「{item.quote}」</p>
          {!view.applied ? (
            <button type="button" className="mt-1 text-xs text-graphite-300 underline decoration-graphite-700 underline-offset-2 hover:text-graphite-100" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
              {editing ? '收起编辑' : '编辑'}
            </button>
          ) : null}
          {editing && !view.applied ? <ItemEditor item={item} refDate={refDate} onChange={(it) => onEdit(view.key, it)} /> : null}
        </div>
      </div>
    </li>
  );
}

/** A few fields per kind; changes are checked again on the server when applied. */
function ItemEditor({ item, refDate, onChange }: { item: PasteItem; refDate: string; onChange: (it: PasteItem) => void }) {
  const named = NAMED_KINDS.includes(item.kind);
  const slot = item.slots[0] ?? null;
  const setSlot = (patch: Partial<NonNullable<typeof slot>>) => {
    // a new slot starts on the messages' date (the note's own reference, not the browser's UTC day)
    const base = slot ?? { date: refDate, weekday: null, start: null, end: null, vague: false };
    onChange({ ...item, slots: [{ ...base, ...patch, weekday: patch.date ? null : base.weekday }, ...item.slots.slice(1)] });
  };
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 rounded-panel border border-graphite-800 p-2 sm:grid-cols-2">
      {named ? (
        <Field label="归类">
          {({ id }) => (
            <SelectInput id={id} value={item.kind} onChange={(e) => onChange({ ...item, kind: e.target.value as PasteKind })}>
              {NAMED_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PASTE_KIND_LABEL[k]}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
      ) : null}
      {named ? (
        <Field label="名称">{({ id }) => <TextInput id={id} value={item.name ?? ''} onChange={(e) => onChange({ ...item, name: e.target.value || null })} />}</Field>
      ) : null}
      {item.kind === 'todo' ? (
        <>
          <Field label="要做的事">{({ id }) => <TextInput id={id} value={item.task ?? ''} maxLength={200} onChange={(e) => onChange({ ...item, task: e.target.value || null })} />}</Field>
          <Field label="负责人">{({ id }) => <TextInput id={id} value={item.assignee ?? ''} maxLength={40} onChange={(e) => onChange({ ...item, assignee: e.target.value || null })} />}</Field>
        </>
      ) : null}
      {slot || item.kind !== 'take' ? (
        <>
          <Field label="日期">{({ id }) => <TextInput id={id} type="date" value={slot?.date ?? ''} onChange={(e) => e.target.value && setSlot({ date: e.target.value })} />}</Field>
          {item.kind !== 'todo' ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="开始">{({ id }) => <TextInput id={id} type="time" value={slot?.start ?? ''} onChange={(e) => setSlot({ start: e.target.value || null, vague: false })} />}</Field>
              <Field label="结束">{({ id }) => <TextInput id={id} type="time" value={slot?.end ?? ''} onChange={(e) => setSlot({ end: e.target.value || null, vague: false })} />}</Field>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Uncovered({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <details className="mt-6 rounded-panel border border-graphite-800 px-3 py-2">
      <summary className="cursor-pointer text-sm text-graphite-300 select-none hover:text-graphite-100">没有单独成条的消息（{lines.length}）</summary>
      <p className="mt-1 text-xs text-graphite-300">多是闲聊，或已经并进上面的条目。有遗漏的话，可以手工补进计划或待办。</p>
      <ul className="mt-2 flex flex-col gap-1 text-xs break-words text-graphite-300">
        {lines.map((l, i) => (
          <li key={`${i}:${l}`}>{l}</li>
        ))}
      </ul>
    </details>
  );
}
