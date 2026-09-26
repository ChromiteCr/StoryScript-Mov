import { useState } from 'react';
import type { DraftDetail } from '@storyscript/contracts';
import {
  buildEntitySelection,
  ENTITY_DRAFT_KINDS,
  ENTITY_KIND_TYPE,
  formatAliases,
  parseAliasInput,
  parseEntityDraft,
  type EntityDraftRow,
} from '../../lib/drafts.ts';
import { attemptsText } from '../../lib/jobs.ts';
import { DRAFT_STATUS_LABEL, ENTITY_TYPE_LABEL } from '../../lib/labels.ts';
import { useApplyEntityDraft, useDiscardDraft, useDraft } from '../../lib/queries.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Spinner, Tag, TextInput } from '../../components/ui.tsx';
import { useWorkspace } from './context.ts';

interface RowState extends EntityDraftRow {
  aliasText: string;
}

function DraftBody({ detail, onClose }: { detail: DraftDetail; onClose: () => void }) {
  const ws = useWorkspace();
  const apply = useApplyEntityDraft();
  const discard = useDiscardDraft();
  const [rows, setRows] = useState<RowState[]>(() => (parseEntityDraft(detail.draft, ws.entities) ?? []).map((r) => ({ ...r, aliasText: formatAliases(r.aliases) })));
  const parsedOk = parseEntityDraft(detail.draft, []) !== null;

  const pending = detail.draft.status === 'pending';
  const busy = apply.isPending || discard.isPending;
  const selectedCount = rows.filter((r) => r.selected && r.name.trim() !== '').length;

  const patch = (i: number, p: Partial<RowState>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const doApply = () => {
    const body = buildEntitySelection(rows.map((r) => ({ ...r, aliases: parseAliasInput(r.aliasText) })));
    apply.mutate(
      { id: detail.draft.id, input: body },
      {
        onSuccess: (list) => {
          ws.notify(`已写入 ${list.length} 个角色、地点或道具（新条目标为"待确认"）。`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      onClose={onClose}
      variant="drawer"
      busy={busy}
      title="实体草案"
      description={
        <>
          AI 抽取的结果只是草案。勾选要保留的条目，可以先改名、编辑别名；同名条目会合并到已有的角色、地点或道具。
          <span className="mt-0.5 block tabular-nums">
            {detail.draft.model ? `模型 ${detail.draft.model} · ` : ''}
            {attemptsText(detail.draft.attempts)} · 状态：{DRAFT_STATUS_LABEL[detail.draft.status]}
          </span>
        </>
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={doApply} busy={apply.isPending} disabled={!pending || selectedCount === 0 || discard.isPending}>
            应用所选（{selectedCount}）
          </Button>
          <Button variant="ghost" onClick={() => discard.mutate(detail.draft.id, { onSuccess: onClose })} busy={discard.isPending} disabled={!pending || apply.isPending}>
            放弃草案
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {!pending ? <Notice tone="info" title={`这份草案已${DRAFT_STATUS_LABEL[detail.draft.status]}，不能再应用。`} /> : null}
        {detail.draft.issues.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {detail.draft.issues.map((x, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-graphite-100">
                <Tag tone={x.level === 'error' ? 'danger' : 'warn'}>{x.level === 'error' ? '错误' : '提示'}</Tag>
                <span className="min-w-0 pt-0.5 break-words">{x.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!parsedOk ? (
          <Notice tone="warn" title="草案内容无法解析为角色、地点、道具列表">
            可以放弃后重新抽取，或手工新增。
          </Notice>
        ) : rows.length === 0 ? (
          <Notice tone="info" title="模型没有抽取到任何条目。" />
        ) : (
          ENTITY_DRAFT_KINDS.map((kind) => {
            const list = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === kind);
            if (list.length === 0) return null;
            return (
              <section key={kind} aria-label={ENTITY_TYPE_LABEL[ENTITY_KIND_TYPE[kind]]}>
                <h3 className="mb-1.5 text-xs font-medium text-graphite-100">
                  {ENTITY_TYPE_LABEL[ENTITY_KIND_TYPE[kind]]} <span className="text-graphite-300 tabular-nums">{list.length}</span>
                </h3>
                <ul className="divide-y divide-graphite-800 rounded-panel border border-graphite-800">
                  {list.map(({ r, i }) => (
                    <li key={`${kind}-${r.index}`} className={`flex items-start gap-2.5 px-3 py-2 ${r.selected ? '' : 'bg-graphite-950/40'}`}>
                      <input
                        type="checkbox"
                        checked={r.selected}
                        disabled={!pending}
                        onChange={(e) => patch(i, { selected: e.target.checked })}
                        aria-label={`保留 ${r.name}`}
                        className="mt-1.5 size-3.5 shrink-0 accent-graphite-100"
                      />
                      <div className="grid min-w-0 flex-1 gap-1.5">
                        <TextInput aria-label={`第 ${r.index + 1} 条的名称`} value={r.name} disabled={!pending} onChange={(e) => patch(i, { name: e.target.value })} />
                        <TextInput
                          aria-label={`第 ${r.index + 1} 条的别名`}
                          value={r.aliasText}
                          disabled={!pending}
                          onChange={(e) => patch(i, { aliasText: e.target.value })}
                          placeholder="别名，用顿号分隔"
                        />
                        {r.mergeInto ? <p className="text-xs text-graphite-300">与已有的 {r.mergeInto} 同名：应用时合并别名，不会重复创建。</p> : null}
                        {r.duplicateOf ? (
                          <p className="flex items-center gap-1.5 text-xs text-graphite-100">
                            <Tag tone="warn">可能重复</Tag>
                            已有 {r.duplicateOf}，默认不勾选。
                          </p>
                        ) : null}
                        {r.name.trim() === '' && r.selected ? <p className="text-xs text-graphite-100">名称不能为空。</p> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
        {apply.isError ? <ErrorNotice error={apply.error} /> : null}
        {discard.isError ? <ErrorNotice error={discard.error} /> : null}
      </div>
    </Dialog>
  );
}

export function EntityDraftDialog({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const detail = useDraft(draftId);
  if (detail.data) return <DraftBody key={detail.data.draft.id} detail={detail.data} onClose={onClose} />;
  return (
    <Dialog onClose={onClose} variant="drawer" title="实体草案">
      {detail.isError ? <ErrorNotice error={detail.error} /> : <Spinner label="正在读取草案…" />}
    </Dialog>
  );
}
