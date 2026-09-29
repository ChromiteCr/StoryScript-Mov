import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Job, StyleCard, StyleCardInput, StyleLibrary } from '@storyscript/contracts';
import { Plus, Sparkles } from 'lucide-react';
import { isJobInFlight, STYLE_RESEARCH_SLOT, trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { useDiscardDraft, useDraft, useDrafts, useHealth, useJob } from '../../lib/queries.ts';
import {
  useCreateStyle,
  useDeleteStyle,
  useResearchStyle,
  useSaveResearchedStyle,
  useSaveStyleDefaults,
  useStyles,
  useUpdateStyle,
} from '../../lib/queries-style.ts';
import { pageHref } from '../../lib/stages.ts';
import { cardToInput, CONFIDENCE_LABEL, copyOfCard, effectiveStyleId, emptyStyleInput, issuesOf, parseResearchDraft, pendingResearchDrafts } from '../../lib/style-form.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Notice, Spinner, Tag, TextArea, TextInput } from '../../components/ui.tsx';
import { Inspector, InspectorGroup } from '../../components/workspace.tsx';
import { reveal, useWorkspace } from './context.ts';
import { JobLine, useDraftFinder } from './JobLine.tsx';
import { StyleCardDetails, StyleCardForm } from './StyleCardForm.tsx';
import { LevelRow, StyleSelectRow } from './StyleControls.tsx';

/**
 * The style library drawer (S3): the group's default style and difficulty,
 * researching a new style, the group's own cards and the built-in ones.
 * Cards are camera languages named after the technique; a researched card
 * keeps the reference the user typed and is always marked 未核实.
 */

const cardDomId = (id: string) => `style-card-${id}`;

// ------------------------------------------------------------- defaults ----

function DefaultsSection({ library }: { library: StyleLibrary }) {
  const save = useSaveStyleDefaults();
  // show the pick right away while the write is on its way
  const shown = save.isPending && save.variables ? save.variables : library.defaults;
  const styleId = shown.style_id !== null && library.cards.some((c) => c.id === shown.style_id) ? shown.style_id : '';
  return (
    <div className="flex flex-col gap-2">
      <p>新的拆镜表单会先选上这里的风格和难度，每次拆镜时仍可以改。</p>
      <StyleSelectRow cards={library.cards} value={styleId} onChange={(id) => save.mutate({ style_id: id || null, level: shown.level })} />
      <LevelRow value={shown.level} onChange={(level) => save.mutate({ style_id: shown.style_id, level })} />
      {save.isError ? <ErrorNotice error={save.error} /> : null}
    </div>
  );
}

// ------------------------------------------------------------- research ----

function ResearchReview({ draftId, onDone, onSaved }: { draftId: string; onDone: () => void; onSaved: (name: string) => void }) {
  const detail = useDraft(draftId);
  const save = useSaveResearchedStyle();
  const discard = useDiscardDraft();

  if (detail.isError) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return <Spinner label="正在读取研究结果…" />;

  const { draft } = detail.data;
  const pending = draft.status === 'pending';
  const review = parseResearchDraft(draft);
  const reference = typeof draft.scope.reference === 'string' ? draft.scope.reference : null;
  const errors = issuesOf(draft.issues, 'error');
  const warnings = issuesOf(draft.issues, 'warning');
  const drop = (
    <Button variant="ghost" onClick={() => discard.mutate(draft.id, { onSuccess: onDone })} busy={discard.isPending} disabled={!pending || save.isPending}>
      放弃
    </Button>
  );

  if (!pending) {
    return (
      <Notice tone="info" title="这份研究结果已经处理过了">
        <Button size="sm" onClick={onDone}>
          关闭
        </Button>
      </Notice>
    );
  }

  return (
    <section aria-label="研究结果" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="warn" title="通用手法建议，没有和具体影片核对过">
          未核实
        </Tag>
        {review ? <Tag>模型自评把握：{CONFIDENCE_LABEL[review.confidence]}</Tag> : null}
        {reference ? <span className="min-w-0 text-xs break-words text-graphite-300">参考：{reference}</span> : null}
      </div>
      {errors.length > 0 || warnings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {[...errors, ...warnings].map((x, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-graphite-100">
              <Tag tone={x.level === 'error' ? 'danger' : 'warn'}>{x.level === 'error' ? '错误' : '提示'}</Tag>
              <span className="min-w-0 pt-0.5 break-words">{x.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {review && review.caveats.length > 0 ? (
        <div>
          <p className="text-xs text-graphite-300">模型的保留意见</p>
          <ul className="mt-0.5 list-disc pl-4 text-xs leading-5 text-graphite-100">
            {review.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {review ? (
        <>
          <p className="text-xs text-graphite-300">可以先改名、改写，再保存。模型的输出只是草案，不会自动进入风格卡。</p>
          <StyleCardForm
            key={draft.id}
            label="研究结果（草案）"
            initial={review.input}
            submitLabel="保存为风格卡"
            busy={save.isPending}
            error={save.isError ? save.error : discard.isError ? discard.error : undefined}
            onSubmit={(input) => save.mutate({ draftId: draft.id, input }, { onSuccess: (card) => onSaved(card.name) })}
            extraActions={drop}
          />
        </>
      ) : (
        <>
          <Notice tone="warn" title="模型的输出读不成风格卡">
            可以放弃后重新研究，或者换一个参考、补充说明再试。
          </Notice>
          <div>{drop}</div>
        </>
      )}
    </section>
  );
}

function ResearchSection() {
  const ws = useWorkspace();
  const hosted = useHealth().data?.hosted ?? false;
  const research = useResearchStyle();
  const tracked = useTrackedJob(STYLE_RESEARCH_SLOT);
  const trackedJob = useJob(tracked?.jobId ?? null);
  const drafts = useDrafts();
  const findDraft = useDraftFinder();
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);

  const jobBusy = tracked !== null && (trackedJob.data ? isJobInFlight(trackedJob.data) : !trackedJob.isError);
  const blocked = !ws.ai.enabled ? ws.ai.reason : ws.ai.demo ? '演示模式不连接模型，不能研究新风格。可以先用内置风格卡。' : null;
  const waiting = pendingResearchDrafts(drafts.data ?? []);

  const onSucceeded = useCallback(
    async (job: Job) => {
      const id = await findDraft(job, 'style', null);
      if (id) {
        setSavedName(null);
        setDraftId(id);
      }
    },
    [findDraft],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ref = reference.trim();
    if (ref.length < 2) return setError('参考至少写 2 个字');
    setError(null);
    setSavedName(null);
    research.mutate(
      { reference: ref, notes: notes.trim() || null },
      { onSuccess: ({ job_id }) => trackJob(STYLE_RESEARCH_SLOT, job_id) },
    );
  };

  const sentence = hosted
    ? '会用本组配置的模型（和研究用模型、联网搜索设置）发一次请求，最多外发 3 次；计入本组每天的 AI 次数。结果是通用手法建议（未核实）。'
    : '会用你配置的模型（和研究用模型、联网搜索设置）发一次请求，最多外发 3 次。结果是通用手法建议（未核实）。';

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submit} noValidate className="flex flex-col gap-2">
        <Field label="参考" error={error} hint="一个参考，或几个关键词；至少 2 个字。你写的名字只保存在本项目里。">
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={reference}
              maxLength={200}
              onChange={(e) => setReference(e.target.value)}
              placeholder={'例如：某部赛车电影的车载运镜，或者"雨夜、霓虹、慢推"'}
            />
          )}
        </Field>
        <Field label="补充说明（可不填）">
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              value={notes}
              rows={2}
              maxLength={300}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="例如：只有一台手机和一副稳定器，想要快节奏"
            />
          )}
        </Field>
        <p>
          你写的参考和补充说明会发送到 <span className="text-graphite-100">{ws.providerHost ?? '你配置的地址'}</span>。{sentence}
        </p>
        {blocked ? (
          <p>
            {blocked}{' '}
            {!ws.ai.enabled ? (
              <a href={pageHref('settings')} className="text-graphite-100 underline underline-offset-2">
                前往设置
              </a>
            ) : null}
          </p>
        ) : null}
        {research.isError ? <ErrorNotice error={research.error} context="ai-request" /> : null}
        <div>
          <Button type="submit" variant="primary" busy={research.isPending} disabled={blocked !== null || jobBusy}>
            {research.isPending ? null : <Sparkles aria-hidden className="size-3.5" />}
            研究
          </Button>
        </div>
      </form>
      <JobLine slot={STYLE_RESEARCH_SLOT} onSucceeded={onSucceeded} onOpenDraft={(id) => setDraftId(id)} />
      {savedName ? (
        <p role="status" className="text-xs text-graphite-100">
          已保存为风格卡「{savedName}」，在下面的“本组的风格卡”里。
        </p>
      ) : null}
      {draftId ? (
        <ResearchReview
          draftId={draftId}
          onDone={() => setDraftId(null)}
          onSaved={(name) => {
            setDraftId(null);
            setSavedName(name);
          }}
        />
      ) : waiting[0] && !jobBusy ? (
        <Notice tone="info" title={`有 ${waiting.length} 份研究结果还没处理`}>
          <Button size="sm" onClick={() => setDraftId(waiting[0] ?? null)}>
            查看最新一份
          </Button>
        </Notice>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- cards ----

function CardItem({
  card,
  isDefault,
  editing,
  onEdit,
  onSetDefault,
  onCopy,
  busy,
}: {
  card: StyleCard;
  isDefault: boolean;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onSetDefault: () => void;
  /** built-in cards only */
  onCopy?: () => void;
  busy: boolean;
}) {
  const update = useUpdateStyle();
  const remove = useDeleteStyle();
  const [confirming, setConfirming] = useState(false);
  const own = card.origin !== 'builtin';

  useEffect(() => {
    if (editing) reveal(cardDomId(card.id), 'nearest');
  }, [editing, card.id]);

  return (
    <li id={cardDomId(card.id)} aria-label={card.name} className="rounded-panel border border-graphite-800 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold break-words text-graphite-100">{card.name}</h4>
          {card.summary ? <p className="mt-0.5 text-xs text-graphite-300">{card.summary}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {isDefault ? <Tag tone="ok">本组默认</Tag> : null}
          {card.unverified ? (
            <Tag tone="warn" title="通用手法建议，没有和具体影片核对过">
              未核实
            </Tag>
          ) : null}
        </div>
      </div>
      {card.reference ? (
        <p className="mt-1 text-xs text-graphite-300">
          参考：<span className="break-words text-graphite-100">{card.reference}</span>
        </p>
      ) : null}

      {editing ? (
        <div className="mt-2">
          <StyleCardForm
            autoFocus
            label={`编辑风格卡：${card.name}`}
            initial={cardToInput(card)}
            submitLabel="保存修改"
            busy={update.isPending}
            error={update.isError ? update.error : undefined}
            onSubmit={(input) => update.mutate({ id: card.id, input }, { onSuccess: () => onEdit(false) })}
            onCancel={() => onEdit(false)}
          />
        </div>
      ) : (
        <>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-graphite-300 select-none hover:text-graphite-100">展开详情</summary>
            <div className="mt-2">
              <StyleCardDetails card={card} />
            </div>
          </details>
          {confirming ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-graphite-100">删除「{card.name}」？用它拆出的镜头不受影响，但它不能再被选用。</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  busy={remove.isPending}
                  onClick={() => remove.mutate(card.id, { onSuccess: () => setConfirming(false) })}
                  aria-label={`确认删除：${card.name}`}
                >
                  确认删除
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={remove.isPending}>
                  取消
                </Button>
              </div>
              {remove.isError ? <ErrorNotice error={remove.error} /> : null}
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {isDefault ? null : (
                <Button size="sm" onClick={onSetDefault} disabled={busy} aria-label={`设为默认：${card.name}`}>
                  设为默认
                </Button>
              )}
              {own ? (
                <>
                  <Button size="sm" onClick={() => onEdit(true)} aria-label={`编辑：${card.name}`}>
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`删除：${card.name}`}>
                    删除
                  </Button>
                </>
              ) : onCopy ? (
                <Button size="sm" onClick={onCopy} disabled={busy} aria-label={`复制一份再改：${card.name}`}>
                  复制一份再改
                </Button>
              ) : null}
            </div>
          )}
        </>
      )}
    </li>
  );
}

// --------------------------------------------------------------- dialog ----

function LibraryBody({ library }: { library: StyleLibrary }) {
  const create = useCreateStyle();
  const copier = useCreateStyle();
  const save = useSaveStyleDefaults();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const own = library.cards.filter((c) => c.origin !== 'builtin');
  const builtin = library.cards.filter((c) => c.origin === 'builtin');
  const defaultId = effectiveStyleId(null, library);

  const setDefault = (id: string) => save.mutate({ style_id: id, level: library.defaults.level });
  const copy = (card: StyleCard) =>
    copier.mutate(copyOfCard(card), {
      onSuccess: (made) => {
        setCreating(false);
        setEditingId(made.id);
      },
    });

  return (
    <Inspector>
      <InspectorGroup title="本组默认" note={<DefaultsSection library={library} />} />
      <InspectorGroup title="研究新风格" note={<ResearchSection />} />
      <InspectorGroup
        title="本组的风格卡"
        actions={
          <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
            <Plus aria-hidden className="size-3" />
            新建风格卡
          </Button>
        }
        note={
          <div className="flex flex-col gap-3">
            {creating ? (
              <StyleCardForm
                autoFocus
                label="新建风格卡"
                initial={emptyStyleInput()}
                submitLabel="保存风格卡"
                busy={create.isPending}
                error={create.isError ? create.error : undefined}
                onSubmit={(input: StyleCardInput) => create.mutate(input, { onSuccess: () => setCreating(false) })}
                onCancel={() => setCreating(false)}
              />
            ) : null}
            {own.length === 0 && !creating ? (
              <p>还没有自己的风格卡。可以新建一张，用上面的“研究”整理一个参考，或者复制一张内置卡再改。</p>
            ) : (
              <ul aria-label="本组的风格卡" className="flex flex-col gap-2">
                {own.map((c) => (
                  <CardItem
                    key={c.id}
                    card={c}
                    isDefault={defaultId === c.id}
                    editing={editingId === c.id}
                    onEdit={(on) => setEditingId(on ? c.id : null)}
                    onSetDefault={() => setDefault(c.id)}
                    busy={save.isPending}
                  />
                ))}
              </ul>
            )}
            {save.isError ? <ErrorNotice error={save.error} /> : null}
          </div>
        }
      />
      <InspectorGroup
        title="内置风格卡"
        note={
          <div className="flex flex-col gap-3">
            <p>内置卡是只读的：可以设为默认，或者复制一份再改。它们按手法命名，不引用具体影片。</p>
            <ul aria-label="内置风格卡" className="flex flex-col gap-2">
              {builtin.map((c) => (
                <CardItem
                  key={c.id}
                  card={c}
                  isDefault={defaultId === c.id}
                  editing={false}
                  onEdit={() => undefined}
                  onSetDefault={() => setDefault(c.id)}
                  onCopy={() => copy(c)}
                  busy={save.isPending || copier.isPending}
                />
              ))}
            </ul>
            {copier.isError ? <ErrorNotice error={copier.error} /> : null}
          </div>
        }
      />
    </Inspector>
  );
}

export function StyleLibraryDialog({ onClose }: { onClose: () => void }) {
  const styles = useStyles();
  return (
    <Dialog
      variant="drawer"
      title="风格库"
      onClose={onClose}
      bodyClassName=""
      description="拆镜时可以选用风格卡；卡上的文字会作为数据发给你配置的模型。"
    >
      {styles.data ? (
        <LibraryBody library={styles.data} />
      ) : styles.isError ? (
        <div className="p-4">
          <ErrorNotice error={styles.error} />
        </div>
      ) : (
        <div className="p-4">
          <Spinner label="正在读取风格库…" />
        </div>
      )}
    </Dialog>
  );
}
