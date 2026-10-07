import { useId, useState, type FormEvent } from 'react';
import type { Todo } from '@storyscript/contracts';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useMe } from '../../components/AccountMenu.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, IconButton, SelectInput, TextInput } from '../../components/ui.tsx';
import { EmptyState, Panel } from '../../components/workspace.tsx';
import { assigneeText, dueText, todoOverdue } from '../../lib/paste.ts';
import { useCreateTodo, useDeleteTodo, useTodos, useUpdateTodo } from '../../lib/queries-paste.ts';
import { useHealth } from '../../lib/queries.ts';
import { todayIn } from './data.ts';

/**
 * S5a todos on the plan page: what has to happen before the shoot, who does
 * it (on the hosted server a member, shown with their crew roles) and by
 * when. Anyone ticks, edits or deletes; done ones fold away. Todos also come
 * from 粘贴整理.
 */

export function TodoPanel({ timezone }: { timezone: string }) {
  const todos = useTodos();
  const update = useUpdateTodo();
  const remove = useDeleteTodo();
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Todo | 'new' | null>(null);
  // a tick shows at once; a todo ticked here stays in view (struck through) until the page is left
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [justDone, setJustDone] = useState<ReadonlySet<string>>(() => new Set());
  const today = todayIn(timezone);
  const list = todos.data ?? [];
  const isDone = (t: Todo) => ticks.get(t.id) ?? t.done !== null;
  const open = list.filter((t) => !isDone(t));
  const done = list.filter((t) => isDone(t) && !justDone.has(t.id));
  const shown = showDone ? list : list.filter((t) => !isDone(t) || justDone.has(t.id));
  const tick = (t: Todo, on: boolean) => {
    setTicks((m) => new Map(m).set(t.id, on));
    if (on) setJustDone((s) => new Set(s).add(t.id));
    update.mutate(
      { id: t.id, input: { done: on, expected_revision: t.revision } },
      {
        onSettled: () =>
          setTicks((m) => {
            const next = new Map(m);
            next.delete(t.id);
            return next;
          }),
      },
    );
  };

  return (
    <Panel
      title={`待办 ${open.length}`}
      padded={false}
      tools={<IconButton icon={Plus} label="新建待办" onClick={() => setEditing('new')} />}
    >
      {todos.isError ? (
        <div className="p-3">
          <ErrorNotice error={todos.error} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState quiet title="还没有待办。" description="点 + 新建，或在「粘贴整理」里从群聊整理出来。" />
      ) : (
        <>
          <ul className="flex flex-col py-1">
            {shown.map((t) => {
              const due = dueText(t, today);
              const late = !isDone(t) && todoOverdue(t, today);
              const who = assigneeText(t);
              return (
                <li key={t.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-graphite-800/60">
                  <input
                    type="checkbox"
                    checked={isDone(t)}
                    aria-label={t.text}
                    onChange={(e) => {
                      if (!ticks.has(t.id)) tick(t, e.target.checked);
                    }}
                    className="mt-1 size-3.5 shrink-0 accent-graphite-100"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm break-words ${isDone(t) ? 'text-graphite-300 line-through decoration-graphite-500' : 'text-graphite-100'}`}>{t.text}</p>
                    {who || due ? (
                      <p className="flex flex-wrap gap-x-2 text-xs text-graphite-300 tabular-nums">
                        {who ? <span>{who}</span> : null}
                        {due ? (
                          <span className={late ? 'inline-flex items-center gap-1 text-graphite-100' : ''}>
                            {late ? <span aria-hidden className="size-1.5 rounded-full bg-warn" /> : null}
                            {late ? `已过期：${due}` : `${due}前`}
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <span className="flex shrink-0 items-center opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                    <IconButton icon={Pencil} label={`编辑：${t.text}`} onClick={() => setEditing(t)} />
                    <IconButton icon={Trash2} label={`删除：${t.text}`} onClick={() => remove.mutate(t.id)} />
                  </span>
                </li>
              );
            })}
          </ul>
          {done.length > 0 ? (
            <div className="px-3 pb-2">
              <Button variant="ghost" size="sm" aria-pressed={showDone} onClick={() => setShowDone((s) => !s)}>
                {showDone ? '隐藏已完成' : `显示已完成（${done.length}）`}
              </Button>
            </div>
          ) : null}
          {update.isError ? <ErrorNotice className="mx-3 mb-2" error={update.error} /> : null}
          {remove.isError ? <ErrorNotice className="mx-3 mb-2" error={remove.error} /> : null}
        </>
      )}
      {editing ? <TodoDialog todo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Panel>
  );
}

function TodoDialog({ todo, onClose }: { todo: Todo | null; onClose: () => void }) {
  const hosted = useHealth().data?.hosted ?? false;
  const members = useMe(hosted).data?.group?.members ?? [];
  const create = useCreateTodo();
  const update = useUpdateTodo();
  const formId = useId();
  const [text, setText] = useState(todo?.text ?? '');
  const [member, setMember] = useState(todo?.assignee_id ?? '');
  const [name, setName] = useState(todo && !todo.assignee_id ? (todo.assignee_name ?? '') : '');
  const [date, setDate] = useState(todo?.due_date ?? '');
  const [time, setTime] = useState(todo?.due_time ?? '');
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const input = {
      text: text.trim(),
      assignee_id: hosted && member ? member : null,
      assignee_name: hosted && member ? null : name.trim() || null,
      due_date: date || null,
      due_time: date && time ? time : null,
    };
    const done = { onSuccess: onClose };
    if (todo) update.mutate({ id: todo.id, input: { ...input, expected_revision: todo.revision } }, done);
    else create.mutate(input, done);
  };

  return (
    <Dialog
      onClose={onClose}
      busy={busy}
      title={todo ? '编辑待办' : '新建待办'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy} disabled={!text.trim()}>
            保存
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field label="要做的事">{({ id }) => <TextInput id={id} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} autoFocus />}</Field>
        {hosted ? (
          <Field label="负责人" hint={member ? undefined : '不选组员时，可以在下面写一个名字'}>
            {({ id }) => (
              <SelectInput id={id} value={member} onChange={(e) => setMember(e.target.value)}>
                <option value="">（不指派组员）</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.crew_roles.length ? `${m.name}（${m.crew_roles.join('、')}）` : m.name}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
        ) : null}
        {!hosted || !member ? (
          <Field label={hosted ? '或写一个名字' : '负责人'}>{({ id }) => <TextInput id={id} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}</Field>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Field label="截止日期">{({ id }) => <TextInput id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="时间（可不填）">{({ id }) => <TextInput id={id} type="time" value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} />}</Field>
        </div>
        {error ? <ErrorNotice error={error} /> : null}
      </form>
    </Dialog>
  );
}
