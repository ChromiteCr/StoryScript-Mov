import { useCallback, useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Scene, Shot, ShotTipsView } from '@storyscript/contracts';
import { RefreshCw, Sparkles } from 'lucide-react';
import { isTerminalJob, tipsSlot, trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { useHealth, useJob, useShots } from '../../lib/queries.ts';
import { tipsKeys, useShotTips, useStartShotTips } from '../../lib/queries-tips.ts';
import {
  difficultyText,
  gearLabels,
  keySource,
  sceneHasAiTips,
  tipsAction,
  tipsBlockedReason,
  tipsByShot,
  tipsConfirmLines,
  tipsConfirmTitle,
  tipsDoneNotice,
  tipSourceText,
  TIPS_REGENERATE_LABEL,
  TIPS_STALE_TEXT,
  TIPS_START_LABEL,
} from '../../lib/tips.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Spinner, Tag } from '../../components/ui.tsx';
import { useWorkspace } from './context.ts';
import { JobLine } from './JobLine.tsx';

/**
 * S5c 拍摄提示 in the shot editor (saved shots): difficulty and gear, where
 * they come from (the model, or a first guess from the shot's fields), the
 * model's tips and the usual mistake. One job per scene, after a
 * confirmation; a shot changed since reads 「镜头改过，提示可能过时」. Hints
 * only: nothing here changes the shot.
 */
export function ShotTipsGroup({ shot, scene, unsaved }: { shot: Shot; scene: Scene | null; unsaved: boolean }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const view = useShotTips();
  const shots = useShots();
  const start = useStartShotTips();
  const titleId = useId();
  const sceneId = scene?.id ?? shot.scene_id;
  const sceneNo = scene?.display_no ?? '';
  const slot = tipsSlot(sceneId);
  const tracked = useTrackedJob(slot);
  const trackedJob = useJob(tracked?.jobId ?? null);
  // a failed job stays on screen (with its reason) until closed; only a queued or running one blocks a new request
  const running = start.isPending || (tracked !== null && (trackedJob.data ? !isTerminalJob(trackedJob.data) : !trackedJob.isError));
  const [confirming, setConfirming] = useState(false);

  const tips = useMemo(() => tipsByShot(view.data), [view.data]);
  const tip = tips.get(shot.id) ?? null;
  const sceneShotIds = useMemo(() => (shots.data ?? []).filter((s) => s.scene_id === sceneId && !s.archived).map((s) => s.id), [shots.data, sceneId]);
  const action = tipsAction(tip);
  const blocked = tipsBlockedReason({ ai: ws.ai, shots: sceneShotIds.length, running });

  const onSucceeded = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: tipsKeys.view });
    const note = tipsDoneNotice(sceneNo, sceneShotIds, tipsByShot(qc.getQueryData<ShotTipsView>(tipsKeys.view)));
    if (note) ws.notify(note);
  }, [qc, sceneNo, sceneShotIds, ws]);

  const launch = () => {
    start.mutate(sceneId, {
      onSuccess: ({ job_id }) => {
        trackJob(slot, job_id);
        setConfirming(false);
      },
    });
  };

  const openConfirm = () => {
    start.reset();
    setConfirming(true);
  };

  return (
    <section aria-labelledby={titleId} className="py-3 first:pt-2">
      <div className="flex min-h-6 items-center justify-between gap-2 px-3">
        <h3 id={titleId} className="text-xs font-medium text-graphite-100">
          拍摄提示
        </h3>
        {action.stale ? null : (
          <Button variant="ghost" size="sm" disabled={blocked !== null} title={blocked ?? '按本场的镜头生成难度、器材、2–3 条实拍提示和常见失误；只作参考，不改镜头'} onClick={openConfirm}>
            <Sparkles aria-hidden className="size-3" />
            {TIPS_START_LABEL}
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-2 px-3">
        {view.isPending ? (
          <Spinner label="正在读取拍摄提示…" />
        ) : view.isError ? (
          <ErrorNotice error={view.error} />
        ) : tip ? (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <Tag tone={tip.difficulty === 'hard' ? 'warn' : 'neutral'}>{difficultyText(tip.difficulty)}</Tag>
              {gearLabels(tip.gear).map((g) => (
                <Tag key={g}>{g}</Tag>
              ))}
            </div>
            <p className="text-xs text-graphite-300" title={tip.source === 'ai' ? '模型按本场镜头写的提示' : '没有调用模型：按景别、运动、人物、台词和时段估计的难度和器材'}>
              {tipSourceText(tip)}
            </p>
            {tip.tips.length > 0 ? (
              <ol className={`flex list-decimal flex-col gap-1 pl-4 text-sm leading-6 ${action.stale ? 'text-graphite-300' : 'text-graphite-100'}`}>
                {tip.tips.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            ) : null}
            {tip.mistake ? (
              <p className="text-sm leading-6 text-graphite-300">
                <span className="text-graphite-100">常见失误：</span>
                {tip.mistake}
              </p>
            ) : null}
          </>
        ) : null}
        {action.stale ? (
          <Notice tone="warn" title={TIPS_STALE_TEXT}>
            <Button size="sm" className="mt-1.5" disabled={blocked !== null} title={blocked ?? '按本场现在的镜头重新生成提示'} onClick={openConfirm}>
              <RefreshCw aria-hidden className="size-3" />
              {TIPS_REGENERATE_LABEL}
            </Button>
          </Notice>
        ) : null}
        {start.isError && !confirming ? <ErrorNotice error={start.error} context="ai-request" /> : null}
        <JobLine slot={slot} onSucceeded={onSucceeded} successNote="正在载入提示…" />
      </div>
      {confirming ? (
        <ConfirmTips
          sceneNo={sceneNo}
          shots={sceneShotIds.length}
          again={sceneHasAiTips(sceneShotIds, tips)}
          unsaved={unsaved}
          busy={start.isPending}
          error={start.error}
          onConfirm={launch}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}

function ConfirmTips({
  sceneNo,
  shots,
  again,
  unsaved,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  sceneNo: string;
  shots: number;
  again: boolean;
  unsaved: boolean;
  busy: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const health = useHealth().data;
  const lines = tipsConfirmLines({ demo: ws.ai.demo, host: ws.providerHost, sceneNo, shots, key: keySource(health), again, unsaved });

  return (
    <Dialog
      onClose={onClose}
      busy={busy}
      title={tipsConfirmTitle(again)}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={onConfirm} busy={busy} disabled={!ws.ai.enabled}>
            {busy ? null : <Sparkles aria-hidden className="size-3.5" />}
            开始生成
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 text-sm leading-6 text-graphite-300">
        {lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        {error ? <ErrorNotice error={error} context="ai-request" /> : null}
      </div>
    </Dialog>
  );
}
