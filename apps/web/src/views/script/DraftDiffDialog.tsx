import { useMemo, useState, type ReactNode } from 'react';
import type { DraftDetail, Scene, Shot } from '@storyscript/contracts';
import { TECHNIQUES } from '@storyscript/core';
import { Lock, RefreshCw } from 'lucide-react';
import { isRevisionConflict } from '../../lib/errors.ts';
import {
  archiveCandidates,
  buildApplyBreakdownInput,
  defaultSelection,
  draftSceneId,
  keptShotCount,
  parseBreakdownDraft,
  previewShotCodes,
  toggleSelection,
  type BreakdownItem,
  type ClaimFlagView,
} from '../../lib/drafts.ts';
import { attemptsText, usageText } from '../../lib/jobs.ts';
import {
  DEPTH_LABEL,
  DRAFT_STATUS_LABEL,
  ENV_LABEL,
  FACING_LABEL,
  FRAME_FORMAT_LABEL,
  POSE_LABEL,
  PROP_LABEL,
  SCREEN_POS_LABEL,
  SUBJECT_MOTION_LABEL,
  TEMPLATE_LABEL,
  shotSpecLine,
} from '../../lib/labels.ts';
import { useApplyBreakdown, useDiscardDraft, useDraft, useShots } from '../../lib/queries.ts';
import { byNarrative, splitAroundQuote } from '../../lib/shots.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Spinner, Tag } from '../../components/ui.tsx';
import { EmptyState, Panel } from '../../components/workspace.tsx';
import { useWorkspace } from './context.ts';

/**
 * Draft diff view (FR-03, INV-03): the scene's current shots on the left
 * (locked ones marked "不会被改动"), the model's items on the right as cards
 * to tick. Items with an error cannot be ticked; applying sends the ticked
 * indices with expected_revisions for every shot it may archive.
 */

const CLAIM_NOTE = '含具体影片/年份等断言，未核实';

function ClaimList({ claims }: { claims: readonly ClaimFlagView[] }) {
  if (claims.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <Tag tone="warn">{CLAIM_NOTE}</Tag>
      {claims.map((c, i) => (
        <span key={i} className="break-all text-graphite-100">
          {c.text}
        </span>
      ))}
    </div>
  );
}

function CurrentShot({ shot, willArchive }: { shot: Shot; willArchive: boolean }) {
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium text-graphite-100 tabular-nums">{shot.code}</span>
        {shot.locked ? (
          <Tag>
            <Lock aria-hidden className="size-3" />
            锁定 · 不会被改动
          </Tag>
        ) : null}
        {!shot.locked && shot.origin === 'manual' ? <Tag>手工 · 不会被改动</Tag> : null}
        {willArchive ? <Tag tone="danger">将归档</Tag> : null}
      </div>
      <p className="mt-0.5 text-xs text-graphite-300">{shotSpecLine(shot.fields)}</p>
      <p className={`text-sm break-words ${willArchive ? 'text-graphite-300 line-through' : 'text-graphite-100'}`}>{shot.fields.action || '（未填写动作）'}</p>
    </li>
  );
}

/** A quote or paragraph of the script: script text always sits on paper. */
function PaperQuote({ children }: { children: ReactNode }) {
  return (
    <p data-paper="" className="rounded-paper bg-paper px-2.5 py-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink [color-scheme:light]">
      {children}
    </p>
  );
}

function ItemCard({ item, checked, code, disabled, onToggle }: { item: BreakdownItem; checked: boolean; code: string | null; disabled: boolean; onToggle: () => void }) {
  const ws = useWorkspace();
  const f = item.fields;
  const para = ws.paragraphs.get(f.source.paragraph_id);
  const parts = para ? splitAroundQuote(para.text, f.source.quote) : null;
  const technique = f.technique_id ? (TECHNIQUES.find((t) => t.id === f.technique_id)?.name ?? f.technique_id) : null;
  const inputId = `draft-item-${item.index}`;
  const errors = item.issues.filter((x) => x.level === 'error');
  const warnings = item.issues.filter((x) => x.level === 'warning');

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
          aria-describedby={item.blockedReason ? `${inputId}-blocked` : undefined}
          className="mt-1 size-3.5 shrink-0 disabled:cursor-not-allowed"
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs text-graphite-300 tabular-nums">#{item.index + 1}</span>
            {code ? (
              <span className="text-sm font-medium text-graphite-100 tabular-nums" title="预计镜号，以应用后为准">
                {code}
              </span>
            ) : (
              <span className="text-xs text-graphite-300">{item.selectable ? '未选' : '不可应用'}</span>
            )}
            <span className="text-sm text-graphite-100">{shotSpecLine(f)}</span>
            <span className="text-xs text-graphite-300 tabular-nums">{f.est_seconds} 秒</span>
          </label>
          {f.template || f.frame_format || f.set_piece ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {f.template ? <Tag>{TEMPLATE_LABEL[f.template]}</Tag> : null}
              {f.frame_format ? <Tag>{FRAME_FORMAT_LABEL[f.frame_format]}</Tag> : null}
              {f.set_piece ? <Tag>重点段落</Tag> : null}
            </div>
          ) : null}

          <p className="mt-1 text-sm break-words text-graphite-100">{f.action || '（未填写动作）'}</p>
          {f.narrative_purpose ? (
            <p className="text-xs break-words text-graphite-300">
              叙事作用：<span className="text-graphite-100">{f.narrative_purpose}</span>
            </p>
          ) : null}
          {f.dialogue_quote ? <p className="mt-0.5 text-xs break-words text-graphite-300">台词：「{f.dialogue_quote}」</p> : null}

          {f.subjects.length > 0 ? (
            <p className="mt-1 text-xs break-words text-graphite-300">
              人物：
              {f.subjects
                .map((s) =>
                  [
                    ws.aliasLabel(s.alias),
                    s.screen ? SCREEN_POS_LABEL[s.screen] : null,
                    s.depth ? DEPTH_LABEL[s.depth] : null,
                    s.facing ? FACING_LABEL[s.facing] : null,
                    s.pose ? POSE_LABEL[s.pose] : null,
                  ]
                    .filter(Boolean)
                    .join(' '),
                )
                .join('；')}
              {f.pov_owner ? `（视点：${ws.aliasLabel(f.pov_owner)}）` : ''}
            </p>
          ) : null}
          {f.props.length > 0 || f.env || f.subject_motion !== 'none' ? (
            <p className="text-xs text-graphite-300">
              {[
                f.env ? ENV_LABEL[f.env] : null,
                f.subject_motion !== 'none' ? `主体运动 ${SUBJECT_MOTION_LABEL[f.subject_motion]}` : null,
                f.props.length > 0 ? `道具 ${f.props.map((p) => PROP_LABEL[p]).join('、')}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
          {technique ? (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-graphite-300">
              手法：<span className="text-graphite-100">{technique}</span>
              <Tag>通用手法建议（未核实）</Tag>
            </p>
          ) : null}

          <div className="mt-2 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-graphite-300 tabular-nums">引用 {f.source.paragraph_id}</span>
              {item.match === 'exact' ? <Tag tone="ok">原文一致</Tag> : null}
              {item.match === 'fuzzy' ? <Tag tone="warn">近似匹配 · 核对原文后再勾选</Tag> : null}
              {item.match === 'rejected' ? <Tag tone="danger">原文中找不到</Tag> : null}
            </div>
            <PaperQuote>「{f.source.quote}」</PaperQuote>
            {para ? (
              <details className="text-xs text-graphite-300">
                <summary className="cursor-pointer select-none hover:text-graphite-100">查看原段落</summary>
                <div className="mt-1">
                  <PaperQuote>
                    {parts ? (
                      <>
                        {parts[0]}
                        <mark className="rounded-[2px] bg-accent/55 text-ink">{parts[1]}</mark>
                        {parts[2]}
                      </>
                    ) : (
                      para.text
                    )}
                  </PaperQuote>
                </div>
              </details>
            ) : (
              <p className="text-xs text-graphite-100">段落 {f.source.paragraph_id} 不在当前剧本版本中。</p>
            )}
          </div>

          {errors.length > 0 || warnings.length > 0 ? (
            <ul id={item.blockedReason ? `${inputId}-blocked` : undefined} className="mt-2 flex flex-col gap-1">
              {errors.map((x, i) => (
                <li key={`e${i}`} className="flex items-start gap-1.5 text-xs text-graphite-100">
                  <Tag tone="danger">错误</Tag>
                  <span className="min-w-0 pt-0.5 break-words">{x.message}</span>
                </li>
              ))}
              {warnings.map((x, i) => (
                <li key={`w${i}`} className="flex items-start gap-1.5 text-xs text-graphite-100">
                  <Tag tone="warn">提示</Tag>
                  <span className="min-w-0 pt-0.5 break-words">{x.message}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {item.claims.length > 0 ? (
            <div className="mt-2">
              <ClaimList claims={item.claims} />
            </div>
          ) : null}

          {f.assumptions.length > 0 || f.questions.length > 0 ? (
            <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              {f.assumptions.length > 0 ? (
                <div>
                  <p className="text-graphite-300">模型的假设</p>
                  <ul className="mt-0.5 list-disc pl-4 text-graphite-100 marker:text-graphite-500">
                    {f.assumptions.map((a, i) => (
                      <li key={i} className="break-words">
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {f.questions.length > 0 ? (
                <div>
                  <p className="text-graphite-300">需要你确认</p>
                  <ul className="mt-0.5 list-disc pl-4 text-graphite-100 marker:text-graphite-500">
                    {f.questions.map((q, i) => (
                      <li key={i} className="break-words">
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function DiffBody({
  detail,
  scene,
  onClose,
  onRefresh,
  refreshing,
}: {
  detail: DraftDetail;
  scene: Scene | null;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const ws = useWorkspace();
  const apply = useApplyBreakdown();
  const discard = useDiscardDraft();
  const { draft } = detail;
  const parsed = useMemo(() => parseBreakdownDraft(draft, detail.claim_flags), [draft, detail.claim_flags]);
  const items = parsed.ok ? parsed.items : [];
  const [selected, setSelected] = useState<Set<number>>(() => defaultSelection(items));
  const [replace, setReplace] = useState(false);

  const current = useMemo(() => detail.current_shots.filter((s) => !s.archived).sort(byNarrative), [detail.current_shots]);
  const candidates = useMemo(() => new Set(archiveCandidates(current).map((s) => s.id)), [current]);
  const pending = draft.status === 'pending';
  const busy = apply.isPending || discard.isPending;

  const selectedSorted = [...selected].sort((a, b) => a - b);
  const codes = previewShotCodes(current, replace, selectedSorted.length);
  const codeFor = (index: number) => {
    const pos = selectedSorted.indexOf(index);
    return pos < 0 ? null : (codes[pos] ?? null);
  };
  const after = keptShotCount(current, replace) + selected.size;
  const errorItems = items.filter((i) => !i.selectable).length;

  const doApply = () => {
    const body = buildApplyBreakdownInput({ items, selected, replaceExisting: replace, currentShots: current });
    apply.mutate(
      { id: draft.id, input: body },
      {
        onSuccess: (r) => {
          const parts = [`已写入 ${r.created.length} 个镜头`];
          if (r.archived_ids.length > 0) parts.push(`归档 ${r.archived_ids.length} 个`);
          if (r.skipped_locked_ids.length > 0) parts.push(`${r.skipped_locked_ids.length} 个锁定镜头未改动`);
          ws.notify(`第 ${scene?.display_no ?? ''} 场：${parts.join('，')}。`);
          onClose();
        },
      },
    );
  };

  const usage = usageText(draft.usage);

  return (
    <Dialog
      onClose={onClose}
      variant="full"
      busy={busy}
      title={scene ? `AI 拆镜草案 · 第 ${scene.display_no} 场 ${scene.heading}` : 'AI 拆镜草案'}
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span className="text-graphite-100">草案不会自动写入镜头表：勾选后应用。输出为通用手法建议，未核实。</span>
          {draft.model ? <span>模型 {draft.model}</span> : null}
          <span className="tabular-nums">{attemptsText(draft.attempts)}</span>
          {usage ? <span className="tabular-nums">{usage}</span> : null}
          <span>状态：{DRAFT_STATUS_LABEL[draft.status]}</span>
        </span>
      }
      headerActions={
        <Button variant="ghost" size="sm" onClick={onRefresh} busy={refreshing} title="重新读取草案和本场镜头">
          {refreshing ? null : <RefreshCw aria-hidden className="size-3" />}
          <span className="max-md:sr-only">刷新</span>
        </Button>
      }
      bodyClassName="bg-graphite-950 p-1"
      footer={
        <div className="flex flex-col gap-2">
          {apply.isError ? (
            <div className="flex flex-col items-start gap-2">
              <ErrorNotice error={apply.error} context="apply-breakdown" className="w-full" />
              {isRevisionConflict(apply.error) ? (
                <Button
                  size="sm"
                  onClick={() => {
                    apply.reset();
                    onRefresh();
                  }}
                >
                  <RefreshCw aria-hidden className="size-3" />
                  刷新后重新勾选
                </Button>
              ) : null}
            </div>
          ) : null}
          {discard.isError ? <ErrorNotice error={discard.error} /> : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className={`inline-flex items-center gap-2 text-sm ${candidates.size === 0 ? 'text-graphite-300' : 'text-graphite-100'}`}>
              <input
                type="checkbox"
                checked={replace}
                disabled={!pending || candidates.size === 0 || busy}
                onChange={(e) => setReplace(e.target.checked)}
                className="size-3.5"
              />
              替换本场未锁定的 AI 镜头{candidates.size > 0 ? `（将归档 ${candidates.size} 个）` : '（没有可替换的）'}
            </label>
            <span className="text-xs text-graphite-300 tabular-nums">应用后本场 {after} 个镜头</span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => discard.mutate(draft.id, { onSuccess: onClose })} busy={discard.isPending} disabled={!pending || apply.isPending}>
                放弃草案
              </Button>
              <Button variant="primary" onClick={doApply} busy={apply.isPending} disabled={!pending || selected.size === 0 || discard.isPending}>
                应用所选（{selected.size}）
              </Button>
            </span>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-1 lg:grid lg:h-full lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title={`本场现有镜头 · ${current.length}`} padded={false}>
          <p className="border-b border-graphite-800 px-3 py-2 text-xs text-graphite-300">
            锁定的镜头和手工镜头不会被改动。勾选"替换"时，其余 AI 镜头会被归档，内容仍保留在修订历史里。
          </p>
          {current.length === 0 ? (
            <EmptyState quiet title="本场还没有镜头。" />
          ) : (
            <ol className="divide-y divide-graphite-800">
              {current.map((s) => (
                <CurrentShot key={s.id} shot={s} willArchive={replace && candidates.has(s.id)} />
              ))}
            </ol>
          )}
        </Panel>

        <Panel
          title={`草案镜头 · ${items.length}${errorItems > 0 ? `（${errorItems} 条不可应用）` : ''}`}
          tools={
            items.length > 0 ? (
              <>
                <Button variant="ghost" size="sm" disabled={!pending} onClick={() => setSelected(new Set(items.filter((i) => i.selectable).map((i) => i.index)))}>
                  全选可用
                </Button>
                <Button variant="ghost" size="sm" disabled={!pending} onClick={() => setSelected(new Set())}>
                  全不选
                </Button>
              </>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-2">
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
            <ClaimList claims={parsed.draftClaims} />
            <p className="text-xs text-graphite-300">有错误的条目不能勾选；近似匹配的引用默认不勾选，核对原文后再选。</p>
            {!parsed.ok ? (
              <div className="flex flex-col gap-2">
                <Notice tone="warn" title="草案内容不符合镜头格式，不能应用">
                  可以放弃后重新拆镜。
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
                    code={codeFor(it.index)}
                    disabled={!pending || busy}
                    onToggle={() => setSelected((s) => toggleSelection(s, it))}
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

export function DraftDiffDialog({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const ws = useWorkspace();
  const detail = useDraft(draftId);
  const shots = useShots();
  const sceneId = detail.data ? draftSceneId(detail.data.draft) : null;
  const scene = ws.script.scenes.find((s) => s.id === sceneId) ?? null;

  const refresh = () => {
    void detail.refetch();
    void shots.refetch();
  };

  if (detail.data) {
    // remount on refetch so the selection is rebuilt against the new data
    return (
      <DiffBody
        key={`${detail.data.draft.id}:${detail.dataUpdatedAt}`}
        detail={detail.data}
        scene={scene}
        onClose={onClose}
        onRefresh={refresh}
        refreshing={detail.isFetching}
      />
    );
  }
  return (
    <Dialog onClose={onClose} title="AI 拆镜草案">
      {detail.isError ? <ErrorNotice error={detail.error} /> : <Spinner label="正在读取草案…" />}
    </Dialog>
  );
}
