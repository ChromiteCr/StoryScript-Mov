import { useId, useMemo, useState, type FormEvent } from 'react';
import { PolishMode, type Shot, type StyleLevel } from '@storyscript/contracts';
import { POLISH_MODE_HINT, POLISH_MODE_LABEL } from '@storyscript/core';
import { Sparkles } from 'lucide-react';
import { isJobInFlight, POLISH_SLOT, trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { polishAiReason, polishModeNote, polishOutgoingSentence, POLISH_MAX } from '../../lib/polish.ts';
import { useJob, useShots } from '../../lib/queries.ts';
import { useRequestPolish } from '../../lib/queries-polish.ts';
import { useStyles } from '../../lib/queries-style.ts';
import { effectiveLevel, effectiveStyleId } from '../../lib/style-form.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Notice, TextArea } from '../../components/ui.tsx';
import { useWorkspace } from './context.ts';
import { LevelRow, StyleSelectRow } from './StyleControls.tsx';

/** 润色要求: free text the model gets as data (contract limit 500). */
const INSTRUCTION_MAX = 500;

/** 方式: one toggle button per way (PolishMode.options) and the chosen one's hint (same layout as the style controls' rows). */
function ModeRow({ value, shots, onChange, disabled }: { value: PolishMode; shots: number; onChange: (mode: PolishMode) => void; disabled?: boolean }) {
  const labelId = useId();
  const note = polishModeNote(value, shots);
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5">
      <span id={labelId} className="text-xs leading-6 text-graphite-300">
        方式
      </span>
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1">
        {PolishMode.options.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value === m}
            disabled={disabled}
            onClick={() => onChange(m)}
            className={
              'h-6 min-w-0 flex-1 rounded-control border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ' +
              (value === m ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950' : 'border-graphite-700 text-graphite-300 hover:enabled:text-graphite-100')
            }
          >
            {POLISH_MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <p className="col-start-2 text-xs text-graphite-300">{POLISH_MODE_HINT[value]}</p>
      {note ? <p className="col-start-2 text-xs text-graphite-300">{note}</p> : null}
    </div>
  );
}

/**
 * AI 润色 request (S3a): which shots, how (细化 / 优化 / 重写 / 丰富变化), the user's
 * wish, the style and difficulty. Submitting starts one job followed in the
 * shot table (POLISH_SLOT); its result is a draft, never a write.
 */
export function PolishDialog({ shotIds, onClose }: { shotIds: readonly string[]; onClose: () => void }) {
  const ws = useWorkspace();
  const shots = useShots();
  const styles = useStyles();
  const request = useRequestPolish();
  const tracked = useTrackedJob(POLISH_SLOT);
  const trackedJob = useJob(tracked?.jobId ?? null);
  const formId = useId();

  const [mode, setMode] = useState<PolishMode>('refine');
  const [instruction, setInstruction] = useState('');
  // null = not touched: the form follows the group's defaults once they load
  const [styleChoice, setStyleChoice] = useState<string | null>(null);
  const [levelChoice, setLevelChoice] = useState<StyleLevel | null>(null);

  // the shots as they are now: a shot locked or removed since the dialog was opened is left out
  const targets = useMemo(() => {
    const byId = new Map((shots.data ?? []).map((s) => [s.id, s] as const));
    const out: Shot[] = [];
    for (const id of shotIds) {
      const s = byId.get(id);
      if (s && !s.archived && !s.locked) out.push(s);
    }
    return out;
  }, [shots.data, shotIds]);
  const left = shotIds.length - targets.length;

  const styleId = effectiveStyleId(styleChoice, styles.data);
  const level = effectiveLevel(levelChoice, styles.data);
  const chosenStyle = styles.data?.cards.find((c) => c.id === styleId) ?? null;
  const running = tracked !== null && (!trackedJob.data || isJobInFlight(trackedJob.data));
  const tooMany = targets.length > POLISH_MAX;
  const cannot = polishAiReason(ws.ai) ?? (tooMany ? `一次最多 ${POLISH_MAX} 个` : running ? '上一个润色任务还没结束' : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (targets.length === 0 || cannot) return;
    request.mutate(
      {
        shot_ids: targets.map((s) => s.id),
        mode,
        instruction: instruction.trim() === '' ? null : instruction.trim(),
        style_id: styleId || null,
        level,
      },
      {
        onSuccess: ({ job_id }) => {
          trackJob(POLISH_SLOT, job_id);
          ws.showTab('shots'); // the job line is in the shot table
          if (!ws.wide) ws.closeInspector();
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      onClose={onClose}
      busy={request.isPending}
      title={`AI 润色（${targets.length} 个镜头）`}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {cannot ? <span className="mr-auto min-w-0 text-xs text-graphite-300">{cannot}</span> : null}
          <Button variant="ghost" onClick={onClose} disabled={request.isPending}>
            取消
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={request.isPending} disabled={targets.length === 0 || cannot !== null} title={cannot ?? undefined}>
            {request.isPending ? null : <Sparkles aria-hidden className="size-3.5" />}
            开始润色
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <p className="text-xs break-words text-graphite-300">
          镜头：<span className="text-graphite-100">{targets.length > 0 ? targets.map((s) => s.code).join('、') : '（没有可润色的镜头）'}</span>
        </p>
        {left > 0 ? (
          <Notice tone="warn" title={`${left} 个镜头已锁定或已不在镜头表里，不会被润色`} />
        ) : null}
        {tooMany ? <Notice tone="warn" title={`一次最多润色 ${POLISH_MAX} 个镜头`}>先取消几个再来。</Notice> : null}

        <ModeRow value={mode} shots={targets.length} onChange={setMode} disabled={request.isPending} />

        <Field
          label="润色要求（可不填）"
          hint={
            <>
              作为数据发给模型。
              <span className="tabular-nums">
                {instruction.length}/{INSTRUCTION_MAX}
              </span>
            </>
          }
        >
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={INSTRUCTION_MAX}
              placeholder="例如：更有压迫感；把对话拍得更克制；加一个环绕镜头"
              disabled={request.isPending}
            />
          )}
        </Field>

        <StyleSelectRow cards={styles.data?.cards ?? []} value={styleId} onChange={setStyleChoice} disabled={request.isPending} hint={chosenStyle ? undefined : '不指定时，只按上面的方式和要求来。'} />
        <LevelRow value={level} onChange={setLevelChoice} disabled={request.isPending} />
        {styles.isError ? <ErrorNotice error={styles.error} /> : null}

        <p className="text-xs text-graphite-300">
          {polishOutgoingSentence({ shots: targets.length, characters: ws.characters.length, styleName: chosenStyle?.name ?? null, hasInstruction: instruction.trim() !== '' })}{' '}
          <span className="text-graphite-100">{ws.providerHost ?? '你配置的地址'}</span>。结果先进草案，勾选后才写入；每步最多外发 3 次；锁定的镜头不会被改动。
        </p>
        {request.isError ? <ErrorNotice error={request.error} context="ai-request" /> : null}
      </form>
    </Dialog>
  );
}
