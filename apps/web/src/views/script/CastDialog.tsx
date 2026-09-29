import { useState } from 'react';
import { ACTOR_NAME_MAX, type CastSuggestion } from '@storyscript/contracts';
import { castMatchNote, castRowProblem, castSelection, castTargetName, defaultCastRows, type CastRowState } from '../../lib/cast.ts';
import { useApplyCast } from '../../lib/queries-cast.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Tag, TextInput } from '../../components/ui.tsx';
import { useWorkspace } from './context.ts';

/**
 * 填入演员: the script's cast list ("人物：" and the lines after it), read
 * against the characters, ticked line by line. Lines that already match a
 * character start ticked; a line with no character would create one, so it
 * starts unticked and carries an editable name for it. The list is a
 * snapshot taken when the dialog opened, so rows do not shift under the
 * cursor while other queries refetch.
 */
export function CastDialog({ suggestions, onClose }: { suggestions: CastSuggestion[]; onClose: () => void }) {
  const ws = useWorkspace();
  const apply = useApplyCast();
  const [list] = useState(suggestions);
  const [rows, setRows] = useState<CastRowState[]>(() => defaultCastRows(suggestions));

  const patch = (i: number, p: Partial<CastRowState>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const open = list.map((s, i) => ({ s, i })).filter(({ s }) => !s.current);
  const done = list.filter((s) => s.current);
  const { items, problems } = castSelection(list, rows);

  const doApply = () => {
    apply.mutate(
      { items },
      {
        onSuccess: (changed) => {
          ws.notify(`已写入 ${changed.length} 个角色的演员。`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      onClose={onClose}
      variant="drawer"
      busy={apply.isPending}
      title="填入演员"
      description="从剧本开头的人物表读出来的，勾选后写进角色的「演员」。演员姓名只用于计划和通告单，不会发给 AI。"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={apply.isPending}>
            取消
          </Button>
          <Button variant="primary" onClick={doApply} busy={apply.isPending} disabled={items.length === 0 || problems > 0}>
            填入所选（{items.length}）
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {open.length === 0 ? <Notice tone="info" title="人物表里的演员都已经填好了。" /> : null}
        {open.length > 0 ? (
          <ul aria-label="人物表" className="divide-y divide-graphite-800 rounded-panel border border-graphite-800">
            {open.map(({ s, i }) => {
              const row = rows[i]!;
              const note = castMatchNote(s);
              const problem = castRowProblem(s, row);
              return (
                <li key={i} className={`flex flex-col gap-1.5 px-3 py-2.5 ${row.checked ? '' : 'bg-graphite-950/40'}`}>
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={row.checked}
                      onChange={(e) => patch(i, { checked: e.target.checked })}
                      aria-label={`填入：${s.line}`}
                      className="mt-0.5 size-3.5 shrink-0 accent-graphite-100"
                    />
                    <p className="min-w-0 flex-1 text-xs break-words text-graphite-300">{s.line}</p>
                    {note ? <Tag tone={s.match === 'none' ? 'warn' : 'neutral'}>{note}</Tag> : null}
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 pl-6">
                    <TextInput
                      aria-label={`演员（${s.line}）`}
                      aria-invalid={row.checked && row.actor.trim() === '' ? true : undefined}
                      value={row.actor}
                      maxLength={ACTOR_NAME_MAX}
                      onChange={(e) => patch(i, { actor: e.target.value })}
                      placeholder="演员姓名"
                    />
                    <span aria-hidden className="text-graphite-300">
                      →
                    </span>
                    {s.entity_id === null ? (
                      <TextInput
                        aria-label={`新角色的名字（${s.line}）`}
                        aria-invalid={row.checked && row.newName.trim() === '' ? true : undefined}
                        value={row.newName}
                        maxLength={40}
                        onChange={(e) => patch(i, { newName: e.target.value })}
                        placeholder="新角色的名字"
                      />
                    ) : (
                      <span className="min-w-0 text-sm break-words text-graphite-100">{castTargetName(s)}</span>
                    )}
                  </div>
                  {problem ? <p className="pl-6 text-xs text-graphite-100">{problem}</p> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {done.length > 0 ? (
          <section aria-label="已填好" className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-graphite-300">
              已填好 <span className="tabular-nums">{done.length}</span>
            </h3>
            <ul className="flex flex-col gap-1">
              {done.map((s, i) => (
                <li key={i} className="min-w-0 text-xs break-words text-graphite-300">
                  {castTargetName(s)} · {s.actor_name} 饰
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {apply.isError ? <ErrorNotice error={apply.error} /> : null}
      </div>
    </Dialog>
  );
}
