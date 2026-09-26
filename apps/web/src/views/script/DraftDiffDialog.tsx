import { useMemo, useState } from 'react';
import type { DraftDetail, Scene, Shot } from '@storyscript/contracts';
import { TECHNIQUES } from '@storyscript/core';
import { Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import { isRevisionConflict } from '../../lib/errors.ts';
import {
  archiveCandidates,
  buildApplyBreakdownInput,
  defaultSelection,
  draftSceneId,
  keptShotCount,
  parseBreakdownDraft,
  previewShotCode,
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
import { Button, Note, Spinner, Tag } from '../../components/ui.tsx';
import { useWorkspace } from './context.ts';

const CLAIM_NOTE = '含具体影片/年份等断言，未核实';

function ClaimList({ claims }: { claims: readonly ClaimFlagView[] }) {
  if (claims.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tag tone="warn">
        <TriangleAlert aria-hidden className="size-3" />
        {CLAIM_NOTE}
      </Tag>
      {claims.map((c, i) => (
        <span key={i} className="text-xs break-all text-warn">
          {c.text}
        </span>
      ))}
    </div>
  );
}

function CurrentShot({ shot, willArchive }: { shot: Shot; willArchive: boolean }) {
  return (
    <li className={`px-3 py-2 ${willArchive ? 'bg-danger-bg/50' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12.5px] font-semibold text-ink">{shot.code}</span>
        {shot.locked ? (
          <Tag tone="solid">
            <Lock aria-hidden className="size-3" />
            锁定 · 不会被改动
          </Tag>
        ) : null}
        {shot.origin === 'manual' ? <Tag tone="neutral">手工 · 不会被改动</Tag> : null}
        {willArchive ? <Tag tone="danger">将归档</Tag> : null}
      </div>
      <p className="mt-0.5 text-xs text-ink-2">{shotSpecLine(shot.fields)}</p>
      <p className={`text-[13px] break-words ${willArchive ? 'text-ink-3 line-through' : 'text-ink'}`}>{shot.fields.action || '（未填写动作）'}</p>
    </li>
  );
}

function ItemCard({
  item,
  checked,
  code,
  disabled,
  onToggle,
}: {
  item: BreakdownItem;
  checked: boolean;
  code: string | null;
  disabled: boolean;
  onToggle: () => void;
}) {
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
        'rounded-sheet border px-3 py-2.5 ' +
        (!item.selectable ? 'border-danger-rule bg-danger-bg/40' : checked ? 'border-graphite bg-sheet' : 'border-rule bg-sheet-sunk/40')
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
          className="mt-1 size-4 shrink-0 accent-graphite disabled:cursor-not-allowed"
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-ink-3">#{item.index + 1}</span>
            {code ? (
              <span className="font-mono text-[12.5px] font-semibold text-ink" title="预计镜号，以应用后为准">
                {code}
              </span>
            ) : (
              <span className="text-xs text-ink-3">{item.selectable ? '未选' : '不可应用'}</span>
            )}
            <span className="text-[13px] text-ink">{shotSpecLine(f)}</span>
            {f.template ? <Tag>{TEMPLATE_LABEL[f.template]}</Tag> : null}
            {f.frame_format ? <Tag>{FRAME_FORMAT_LABEL[f.frame_format]}</Tag> : null}
            {f.set_piece ? <Tag tone="info">重点段落</Tag> : null}
            <span className="text-xs text-ink-3 tabular-nums">{f.est_seconds} 秒</span>
          </label>

          <p className="mt-1 text-[13px] break-words text-ink">{f.action || '（未填写动作）'}</p>
          {f.narrative_purpose ? (
            <p className="text-xs break-words text-ink-2">
              <span className="text-ink-3">叙事作用：</span>
              {f.narrative_purpose}
            </p>
          ) : null}
          {f.dialogue_quote ? <p className="mt-0.5 text-xs break-words text-ink-2">台词：「{f.dialogue_quote}」</p> : null}

          {f.subjects.length > 0 ? (
            <p className="mt-1 text-xs break-words text-ink-2">
              <span className="text-ink-3">人物：</span>
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
            <p className="text-xs text-ink-2">
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
            <p className="mt-0.5 text-xs text-ink-2">
              手法：{technique} <Tag tone="neutral">通用手法建议（未核实）</Tag>
            </p>
          ) : null}

          <div className="mt-2 rounded-control border-l-2 border-rule-strong bg-sheet-sunk/60 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] text-ink-3">{f.source.paragraph_id}</span>
              {item.match === 'exact' ? <Tag tone="ok">原文一致</Tag> : null}
              {item.match === 'fuzzy' ? <Tag tone="warn">近似匹配 · 请核对原文后勾选</Tag> : null}
              {item.match === 'rejected' ? <Tag tone="danger">原文中找不到</Tag> : null}
            </div>
            <p className="mt-0.5 text-[13px] break-words text-ink">「{f.source.quote}」</p>
            {para ? (
              <details className="mt-0.5 text-xs text-ink-3">
                <summary className="cursor-pointer select-none hover:text-ink-2">查看原段落</summary>
                <p className="mt-1 break-words whitespace-pre-wrap text-ink-2">
                  {parts ? (
                    <>
                      {parts[0]}
                      <mark className="bg-mark px-0.5 text-ink">{parts[1]}</mark>
                      {parts[2]}
                    </>
                  ) : (
                    para.text
                  )}
                </p>
              </details>
            ) : (
              <p className="mt-0.5 text-xs text-danger">段落 {f.source.paragraph_id} 不在当前剧本版本中。</p>
            )}
          </div>

          {errors.length > 0 || warnings.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {errors.map((x, i) => (
                <li key={`e${i}`} className="flex gap-1.5 text-xs text-danger">
                  <Tag tone="danger">错误</Tag>
                  <span className="min-w-0 break-words">{x.message}</span>
                </li>
              ))}
              {warnings.map((x, i) => (
                <li key={`w${i}`} className="flex gap-1.5 text-xs text-warn">
                  <Tag tone="warn">提示</Tag>
                  <span className="min-w-0 break-words">{x.message}</span>
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
                  <p className="text-ink-3">模型的假设</p>
                  <ul className="mt-0.5 list-disc pl-4 text-ink-2">
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
                  <p className="text-ink-3">需要你确认</p>
                  <ul className="mt-0.5 list-disc pl-4 text-ink-2">
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

function DiffBody({ detail, scene, onClose, onRefresh, refreshing }: { detail: DraftDetail; scene: Scene | null; onClose: () => void; onRefresh: () => void; refreshing: boolean }) {
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

  const kept = keptShotCount(current, replace);
  const selectedSorted = [...selected].sort((a, b) => a - b);
  const codeFor = (index: number) => {
    const pos = selectedSorted.indexOf(index);
    return pos < 0 || !scene ? null : previewShotCode(ws.project.code_format, scene.display_no, kept + pos + 1);
  };

  const doApply = () => {
    const body = buildApplyBreakdownInput({ items, selected, replaceExisting: replace, currentShots: current });
    apply.mutate(
      { id: draft.id, input: body },
      {
        onSuccess: (r) => {
          const parts = [`已写入 ${r.created.length} 个镜头`];
          if (r.archived_ids.length > 0) parts.push(`归档 ${r.archived_ids.length} 个`);
          if (r.skipped_locked_ids.length > 0) parts.push(`跳过锁定的 ${r.skipped_locked_ids.length} 个`);
          ws.notify(`第 ${scene?.display_no ?? ''} 场：${parts.join('，')}。`);
          onClose();
        },
      },
    );
  };

  const usage = usageText(draft.usage);

  return (
    <Dialog
      open
      onClose={onClose}
      variant="full"
      busy={busy}
      title={scene ? `AI 拆镜草案 · 第 ${scene.display_no} 场 ${scene.heading}` : 'AI 拆镜草案'}
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span>草案不会自动写入镜头表，勾选后应用。</span>
          {draft.model ? <span className="text-ink-3">模型 {draft.model}</span> : null}
          <span className="text-ink-3">{attemptsText(draft.attempts)}</span>
          <span className="text-ink-3">{usage ?? '用量：未知'}</span>
          <span className="text-ink-3">状态：{DRAFT_STATUS_LABEL[draft.status]}</span>
        </span>
      }
      headerActions={
        <Button variant="ghost" className="h-8 px-2" onClick={onRefresh} busy={refreshing} title="重新读取草案和本场镜头">
          {refreshing ? null : <RefreshCw aria-hidden className="size-3.5" />}
          <span className="hidden sm:inline">刷新</span>
        </Button>
      }
      footer={
        <div className="mx-auto flex max-w-[1200px] flex-col gap-2">
          {apply.isError ? (
            <div className="flex flex-col gap-2">
              <ErrorNotice error={apply.error} context="apply-breakdown" />
              {isRevisionConflict(apply.error) ? (
                <div>
                  <Button
                    onClick={() => {
                      apply.reset();
                      onRefresh();
                    }}
                  >
                    <RefreshCw aria-hidden className="size-3.5" />
                    刷新
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {discard.isError ? <ErrorNotice error={discard.error} /> : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className={`inline-flex items-center gap-2 text-[13px] ${candidates.size === 0 ? 'text-ink-3' : 'text-ink'}`}>
              <input
                type="checkbox"
                checked={replace}
                disabled={!pending || candidates.size === 0 || busy}
                onChange={(e) => setReplace(e.target.checked)}
                className="size-4 accent-graphite"
              />
              替换本场未锁定的 AI 镜头{candidates.size > 0 ? `（将归档 ${candidates.size} 个）` : '（没有可替换的）'}
            </label>
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
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4">
        {!pending ? <Note tone="warn">这份草案已{DRAFT_STATUS_LABEL[draft.status]}，不能再应用。</Note> : null}
        {parsed.draftIssues.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {parsed.draftIssues.map((x, i) => (
              <li key={i} className={`flex gap-1.5 text-[13px] ${x.level === 'error' ? 'text-danger' : 'text-warn'}`}>
                <Tag tone={x.level === 'error' ? 'danger' : 'warn'}>{x.level === 'error' ? '错误' : '提示'}</Tag>
                <span className="min-w-0 break-words">{x.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <ClaimList claims={parsed.draftClaims} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section aria-labelledby="draft-current" className="min-w-0">
            <h3 id="draft-current" className="mb-1.5 text-[13px] font-semibold text-ink">
              本场现有镜头 <span className="font-normal text-ink-3 tabular-nums">{current.length}</span>
            </h3>
            <p className="mb-2 text-xs text-ink-3">锁定的镜头和手工镜头不会被改动。勾选"替换"时，其余 AI 镜头会被归档（可在修订历史中找回内容）。</p>
            {current.length === 0 ? (
              <p className="rounded-sheet border border-dashed border-rule-strong px-3 py-3 text-[13px] text-ink-3">本场还没有镜头。</p>
            ) : (
              <ol className="divide-y divide-rule rounded-sheet border border-rule">
                {current.map((s) => (
                  <CurrentShot key={s.id} shot={s} willArchive={replace && candidates.has(s.id)} />
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="draft-items" className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
              <h3 id="draft-items" className="text-[13px] font-semibold text-ink">
                草案镜头 <span className="font-normal text-ink-3 tabular-nums">{items.length}</span>
              </h3>
              {items.length > 0 ? (
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" className="h-6 px-1.5 text-xs" disabled={!pending} onClick={() => setSelected(new Set(items.filter((i) => i.selectable).map((i) => i.index)))}>
                    全选可用
                  </Button>
                  <Button variant="ghost" className="h-6 px-1.5 text-xs" disabled={!pending} onClick={() => setSelected(new Set())}>
                    全不选
                  </Button>
                </span>
              ) : null}
            </div>
            <p className="mb-2 text-xs text-ink-3">有错误的条目不能勾选；近似匹配的引用默认不勾选，核对原文后再选。输出为通用手法建议，未核实。</p>
            {!parsed.ok ? (
              <div className="flex flex-col gap-2">
                <Note tone="warn">草案内容不符合镜头格式，不能应用。可以放弃后重新拆镜。</Note>
                {draft.raw_output ? (
                  <details className="text-xs text-ink-3">
                    <summary className="cursor-pointer select-none">模型原始输出</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-control bg-sheet-sunk p-2 font-mono text-[11.5px] break-all whitespace-pre-wrap text-ink-2">{draft.raw_output}</pre>
                  </details>
                ) : null}
              </div>
            ) : items.length === 0 ? (
              <Note>模型没有给出镜头。</Note>
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
          </section>
        </div>
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
    <Dialog open onClose={onClose} title="AI 拆镜草案">
      {detail.isError ? <ErrorNotice error={detail.error} /> : <Spinner label="正在读取草案…" />}
    </Dialog>
  );
}
