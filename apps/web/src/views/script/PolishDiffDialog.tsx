import { useMemo, useState } from 'react';
import type { DraftDetail, PolishedShotFields, ShotFields } from '@storyscript/contracts';
import { LEVEL_LABEL, POLISH_MODE_LABEL } from '@storyscript/core';
import { RefreshCw } from 'lucide-react';
import { isRevisionConflict } from '../../lib/errors.ts';
import { attemptsText, usageText } from '../../lib/jobs.ts';
import { DRAFT_STATUS_LABEL } from '../../lib/labels.ts';
import {
  buildApplyPolishInput,
  defaultPolishSelection,
  parsePolishDraft,
  polishAppliedNotice,
  sideLines,
  togglePolishItem,
  type PolishItem,
} from '../../lib/polish.ts';
import { useApplyPolish } from '../../lib/queries-polish.ts';
import { useStyles } from '../../lib/queries-style.ts';
import { useDiscardDraft, useDraft, useShots } from '../../lib/queries.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { ActorLabel } from '../../components/ActorLabel.tsx';
import { Button, Notice, Spinner, Tag } from '../../components/ui.tsx';
import { Panel } from '../../components/workspace.tsx';
import { ClaimList } from './DraftDiffDialog.tsx';
import { useWorkspace } from './context.ts';

/**
 * Polish draft review (S3a, INV-03): one card per shot, 改前 (the shot as it
 * is now) beside 改后 (the model's version), the fields that changed named in
 * bold, the model's note, a tick. Nothing is written before 应用所选; an item
 * with an error, a locked shot, or a shot edited since the request cannot be
 * ticked.
 */

/** One side of a card: the spec line, the action, the camera notes and every other changed field. */
function Side({ title, fields, changedKeys }: { title: string; fields: PolishedShotFields | null; changedKeys: readonly (keyof ShotFields)[] }) {
  const ws = useWorkspace();
  const lines = fields ? sideLines(fields, changedKeys, ws.aliasLabel) : [];
  return (
    <section aria-label={title} className="min-w-0 rounded-control border border-graphite-800 bg-graphite-950 px-2.5 py-2">
      <h3 className="text-xs text-graphite-300">{title}</h3>
      {fields ? (
        <ul className="mt-1 flex flex-col gap-1">
          {lines.map((l) => (
            <li
              key={l.key}
              className={`border-l-2 pl-1.5 break-words ${l.key === 'spec' ? 'text-xs' : 'text-sm'} ${l.changed ? 'border-graphite-300 text-graphite-100' : 'border-transparent text-graphite-300'}`}
            >
              {l.label ? <span className="text-xs text-graphite-300">{l.label}：</span> : null}
              {l.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-graphite-300">这个镜头已不在镜头表里。</p>
      )}
    </section>
  );
}

function ItemCard({ item, checked, disabled, claims, onToggle }: { item: PolishItem; checked: boolean; disabled: boolean; claims: DraftDetail['claim_flags']; onToggle: () => void }) {
  const ws = useWorkspace();
  const scene = item.shot ? ws.script.scenes.find((s) => s.id === item.shot?.scene_id) : undefined;
  const inputId = `polish-item-${item.index}`;
  const blockedId = `${inputId}-blocked`;

  return (
    <li
      className={
        'rounded-panel border px-3 py-2.5 ' +
        (!item.selectable ? 'border-graphite-800 border-l-2 border-l-danger bg-graphite-900' : checked ? 'border-graphite-500 bg-graphite-800' : 'border-graphite-800 bg-graphite-900')
      }
    >
      <div className="flex items-start gap-2.5">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={!item.selectable || disabled}
          onChange={onToggle}
          title={item.blockedReason ?? undefined}
          aria-describedby={item.blockedReason ? blockedId : undefined}
          className="mt-1 size-3.5 shrink-0 accent-graphite-100 disabled:cursor-not-allowed"
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs text-graphite-300 tabular-nums">#{item.index + 1}</span>
            <span className="text-sm font-semibold text-graphite-100 tabular-nums">{item.shot?.code ?? item.ref}</span>
            {scene ? (
              <span className="min-w-0 text-xs break-words text-graphite-300">
                第 {scene.display_no} 场 {scene.heading}
              </span>
            ) : null}
            {item.shot?.locked ? <Tag>锁定 · 不会被改动</Tag> : null}
            {item.stale ? <Tag tone="warn">镜头在润色之后被改过</Tag> : null}
          </label>

          <p className="mt-1.5 text-xs text-graphite-300">
            {item.shot === null ? (
              '镜头已不在镜头表里，这一条不能应用。'
            ) : item.changed.length > 0 ? (
              <>
                改动：<strong className="font-semibold text-graphite-100">{item.changed.join('、')}</strong>
              </>
            ) : (
              '没有字段发生变化。'
            )}
          </p>

          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <Side title="改前" fields={item.before} changedKeys={item.changedKeys} />
            <Side title="改后" fields={item.after} changedKeys={item.changedKeys} />
          </div>

          {item.changeNote ? (
            <p className="mt-2 text-xs break-words text-graphite-300">
              模型的说明：<span className="text-graphite-100">{item.changeNote}</span>
            </p>
          ) : null}

          {item.errors.length > 0 || item.warnings.length > 0 || item.blockedReason ? (
            <ul id={item.blockedReason ? blockedId : undefined} className="mt-2 flex flex-col gap-1">
              {item.errors.map((x, i) => (
                <li key={`e${i}`} className="flex items-start gap-1.5 text-xs text-graphite-100">
                  <Tag tone="danger">错误</Tag>
                  <span className="min-w-0 pt-0.5 break-words">{x.message}</span>
                </li>
              ))}
              {item.warnings.map((x, i) => (
                <li key={`w${i}`} className="flex items-start gap-1.5 text-xs text-graphite-100">
                  <Tag tone="warn">提示</Tag>
                  <span className="min-w-0 pt-0.5 break-words">{x.message}</span>
                </li>
              ))}
              {item.errors.length === 0 && item.blockedReason ? (
                <li className="flex items-start gap-1.5 text-xs text-graphite-100">
                  <Tag tone="danger">不能应用</Tag>
                  <span className="min-w-0 pt-0.5 break-words">{item.blockedReason}</span>
                </li>
              ) : null}
            </ul>
          ) : null}

          {claims.length > 0 ? (
            <div className="mt-2">
              <ClaimList claims={claims} />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function DiffBody({ detail, onClose, onRefresh, refreshing }: { detail: DraftDetail; onClose: () => void; onRefresh: () => void; refreshing: boolean }) {
  const ws = useWorkspace();
  const styles = useStyles();
  const apply = useApplyPolish();
  const discard = useDiscardDraft();
  const { draft } = detail;
  const parsed = useMemo(() => parsePolishDraft(detail), [detail]);
  const items = parsed.ok ? parsed.items : [];
  const [selected, setSelected] = useState<Set<number>>(() => defaultPolishSelection(items));

  const pending = draft.status === 'pending';
  const busy = apply.isPending || discard.isPending;
  const blocked = items.filter((i) => !i.selectable).length;
  const conflict = isRevisionConflict(apply.error);
  const usage = usageText(draft.usage);
  const { scope } = parsed;
  const styleName = scope.styleId ? (styles.data?.cards.find((c) => c.id === scope.styleId)?.name ?? '（这张风格卡已删除）') : '不指定';

  const doApply = () => {
    const input = buildApplyPolishInput({ items, selected, expected: scope.expected });
    apply.mutate(
      { id: draft.id, input },
      {
        onSuccess: (r) => {
          ws.notify(polishAppliedNotice(r));
          onClose();
        },
      },
    );
  };

  const doDiscard = () => discard.mutate(draft.id, { onSuccess: onClose });

  return (
    <Dialog
      onClose={onClose}
      variant="full"
      busy={busy}
      title="AI 润色草案"
      description={
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="text-graphite-100">草案不会自动写入镜头表：勾选后应用。输出为通用手法建议，未核实。</span>
            <ActorLabel actor={draft.actor} after="发起" />
            {scope.mode ? <span>方式 {POLISH_MODE_LABEL[scope.mode]}</span> : null}
            {scope.level ? <span>难度 {LEVEL_LABEL[scope.level]}</span> : null}
            <span>风格 {styleName}</span>
            {draft.model ? <span>模型 {draft.model}</span> : null}
            <span className="tabular-nums">{attemptsText(draft.attempts)}</span>
            {usage ? <span className="tabular-nums">{usage}</span> : null}
            <span>状态：{DRAFT_STATUS_LABEL[draft.status]}</span>
          </span>
          {scope.instruction ? (
            <span className="break-words">
              润色要求：<span className="text-graphite-100">{scope.instruction}</span>
            </span>
          ) : null}
        </span>
      }
      headerActions={
        <Button variant="ghost" size="sm" onClick={onRefresh} busy={refreshing} title="重新读取草案和镜头的最新状态">
          {refreshing ? null : <RefreshCw aria-hidden className="size-3" />}
          <span className="max-md:sr-only">刷新</span>
        </Button>
      }
      bodyClassName="bg-graphite-950 p-1"
      footer={
        <div className="flex flex-col gap-2">
          {conflict ? (
            <Notice tone="warn" title="镜头在润色之后被改过：关掉草案重新润色，或放弃这些改动">
              <p>为避免覆盖你后来的修改，这次没有写入任何镜头。</p>
              <Button size="sm" className="mt-1.5" onClick={doDiscard} busy={discard.isPending}>
                放弃草案
              </Button>
            </Notice>
          ) : apply.isError ? (
            <ErrorNotice error={apply.error} />
          ) : null}
          {discard.isError ? <ErrorNotice error={discard.error} /> : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-xs text-graphite-300 tabular-nums">已勾选 {selected.size} / {items.length} 项</span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {conflict ? null : (
                <Button variant="ghost" onClick={doDiscard} busy={discard.isPending} disabled={!pending || apply.isPending}>
                  放弃草案
                </Button>
              )}
              <Button variant="primary" onClick={doApply} busy={apply.isPending} disabled={!pending || selected.size === 0 || discard.isPending}>
                应用所选（{selected.size}）
              </Button>
            </span>
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <Panel
          title={`润色结果 · ${items.length}${blocked > 0 ? `（${blocked} 条不可应用）` : ''}`}
          tools={
            items.length > 0 ? (
              <>
                <Button variant="ghost" size="sm" disabled={!pending} onClick={() => setSelected(defaultPolishSelection(items))}>
                  全选可用
                </Button>
                <Button variant="ghost" size="sm" disabled={!pending} onClick={() => setSelected(new Set())}>
                  全不选
                </Button>
              </>
            ) : undefined
          }
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            {!pending ? <Notice tone="info" title={`这份草案已${DRAFT_STATUS_LABEL[draft.status]}，不能再应用。`} /> : null}
            {parsed.draftIssues.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {parsed.draftIssues.map((x, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm text-graphite-100">
                    <Tag tone={x.level === 'error' ? 'danger' : 'warn'}>{x.level === 'error' ? '错误' : '提示'}</Tag>
                    <span className="min-w-0 break-words">{x.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <ClaimList claims={detail.claim_flags.filter((c) => c.item === null)} />
            <p className="text-xs text-graphite-300">有错误的条目、锁定的镜头和在润色之后被改过的镜头不能勾选；应用后每个镜头记一次修订，可在修订历史里查看。</p>
            {!parsed.ok ? (
              <div className="flex flex-col gap-2">
                <Notice tone="warn" title="草案内容不符合润色格式，不能应用">
                  可以放弃后重新润色。
                </Notice>
                {draft.raw_output ? (
                  <details className="text-xs text-graphite-300">
                    <summary className="cursor-pointer select-none hover:text-graphite-100">模型原始输出</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-control bg-graphite-950 p-2 font-mono text-xs break-all whitespace-pre-wrap text-graphite-100">
                      {draft.raw_output}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : items.length === 0 ? (
              <Notice tone="info" title="模型没有给出镜头。" />
            ) : (
              <ol className="flex flex-col gap-2">
                {items.map((it) => (
                  <ItemCard
                    key={it.index}
                    item={it}
                    checked={selected.has(it.index)}
                    disabled={!pending || busy}
                    claims={detail.claim_flags.filter((c) => c.item === it.index)}
                    onToggle={() => setSelected((s) => togglePolishItem(s, it))}
                  />
                ))}
              </ol>
            )}
          </div>
        </Panel>
      </div>
    </Dialog>
  );
}

export function PolishDiffDialog({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const detail = useDraft(draftId);
  const shots = useShots();

  const refresh = () => {
    void detail.refetch();
    void shots.refetch();
  };

  if (detail.data) {
    // remount on refetch so the ticks are rebuilt against the new data
    return <DiffBody key={`${detail.data.draft.id}:${detail.dataUpdatedAt}`} detail={detail.data} onClose={onClose} onRefresh={refresh} refreshing={detail.isFetching} />;
  }
  return (
    <Dialog onClose={onClose} title="AI 润色草案">
      {detail.isError ? <ErrorNotice error={detail.error} /> : <Spinner label="正在读取草案…" />}
    </Dialog>
  );
}
