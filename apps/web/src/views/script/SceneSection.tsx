import { memo, useCallback, useId, useState, type FormEvent } from 'react';
import type { Job, Scene, Shot, ShotDraft } from '@storyscript/contracts';
import { TECHNIQUES } from '@storyscript/core';
import { FileText, Plus, Sparkles } from 'lucide-react';
import { breakdownSlot, trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { useRequestBreakdown, useSetNarrativeOrder, useUpdateScene } from '../../lib/queries.ts';
import { moveId, narrativeOrderIds } from '../../lib/shots.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Note, Select, Tag, TextArea, TextInput } from '../../components/ui.tsx';
import { JobLine, useDraftFinder } from './JobLine.tsx';
import { ShotRow } from './ShotRow.tsx';
import { sceneDomId } from './ScriptPane.tsx';
import { useWorkspace } from './context.ts';

// ------------------------------------------------------- AI breakdown form --

function BreakdownForm({ scene, lockedCount, liveCount, onClose }: { scene: Scene; lockedCount: number; liveCount: number; onClose: () => void }) {
  const ws = useWorkspace();
  const request = useRequestBreakdown();
  const [technique, setTechnique] = useState('');
  const [reference, setReference] = useState('');
  const [maxShots, setMaxShots] = useState('12');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = { t: useId(), r: useId(), m: useId(), s: useId() };

  const chosen = TECHNIQUES.find((t) => t.id === technique) ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const max = Number(maxShots);
    const secs = target.trim() === '' ? null : Number(target);
    if (!Number.isInteger(max) || max < 1 || max > 40) return setError('镜头上限需要是 1 到 40 之间的整数');
    if (secs !== null && (!Number.isInteger(secs) || secs <= 0)) return setError('目标时长需要是正整数（秒），或者留空');
    setError(null);
    request.mutate(
      {
        sceneId: scene.id,
        input: { technique_id: technique || null, reference_note: reference.trim() || null, max_shots: max, target_seconds: secs },
      },
      {
        onSuccess: ({ job_id }) => {
          trackJob(breakdownSlot(scene.id), job_id);
          onClose();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3 rounded-sheet border border-rule-strong bg-sheet px-3 py-3 sm:px-4">
      <p className="text-[13px] font-semibold text-ink">AI 拆镜 · 第 {scene.display_no} 场</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={ids.t} className="text-xs font-medium text-ink-2">
            手法
          </label>
          <Select id={ids.t} value={technique} onChange={(e) => setTechnique(e.target.value)}>
            <option value="">不指定（由模型按场面选择）</option>
            {TECHNIQUES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          {chosen ? <p className="text-xs text-ink-3">{chosen.intended_effect}</p> : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={ids.m} className="text-xs font-medium text-ink-2">
              镜头上限
            </label>
            <TextInput id={ids.m} value={maxShots} onChange={(e) => setMaxShots(e.target.value)} inputMode="numeric" className="tabular-nums" />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={ids.s} className="text-xs font-medium text-ink-2">
              目标时长（秒）
            </label>
            <TextInput id={ids.s} value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" placeholder="可不填" className="tabular-nums" />
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={ids.r} className="text-xs font-medium text-ink-2">
          参考说明
        </label>
        <TextArea
          id={ids.r}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="例如：节奏克制，多用静止的近景"
        />
        <p className="text-xs text-ink-3">仅作风格参考，输出为通用手法建议（未核实），不会引用具体影片的镜头。{reference.length}/500</p>
      </div>
      <Note>
        将发送本场 {scene.paragraph_ids.length} 个段落和角色名单（{ws.characters.length} 人）到{' '}
        <span className="font-mono text-[12.5px]">{ws.providerHost ?? '你配置的地址'}</span>。结果先进草案，勾选后才写入镜头表。
        {lockedCount > 0 ? ` 本场 ${lockedCount} 个锁定镜头不会被改动。` : liveCount > 0 ? ' 需要保护的镜头可以先锁定。' : ''}
      </Note>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {request.isError ? <ErrorNotice error={request.error} context="ai-request" /> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={request.isPending}>
          {request.isPending ? null : <Sparkles aria-hidden className="size-3.5" />}
          开始拆镜
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={request.isPending}>
          取消
        </Button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------- screen sides --

function SceneSetup({ scene }: { scene: Scene }) {
  const ws = useWorkspace();
  const update = useUpdateScene();
  const left = scene.screen_sides?.left ?? '';
  const right = scene.screen_sides?.right ?? '';
  const ids = { l: useId(), r: useId(), loc: useId() };

  const setSides = (l: string, r: string) =>
    update.mutate({ id: scene.id, input: { screen_sides: l === '' && r === '' ? null : { left: l || null, right: r || null } } });

  const aliasOpts = (current: string) => {
    const list = ws.characters.map((c) => c.alias);
    return current && !list.includes(current) ? [current, ...list] : list;
  };

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={ids.l} className="text-[11px] text-ink-3">
          画左
        </label>
        <Select id={ids.l} value={left} onChange={(e) => setSides(e.target.value, right)} className="h-7 w-32 text-[13px]" disabled={update.isPending}>
          <option value="">—</option>
          {aliasOpts(left).map((a) => (
            <option key={a} value={a}>
              {ws.aliasLabel(a)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={ids.r} className="text-[11px] text-ink-3">
          画右
        </label>
        <Select id={ids.r} value={right} onChange={(e) => setSides(left, e.target.value)} className="h-7 w-32 text-[13px]" disabled={update.isPending}>
          <option value="">—</option>
          {aliasOpts(right).map((a) => (
            <option key={a} value={a}>
              {ws.aliasLabel(a)}
            </option>
          ))}
        </Select>
      </div>
      {ws.locations.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={ids.loc} className="text-[11px] text-ink-3">
            地点
          </label>
          <Select
            id={ids.loc}
            value={scene.location_entity_id ?? ''}
            onChange={(e) => update.mutate({ id: scene.id, input: { location_entity_id: e.target.value || null } })}
            className="h-7 w-36 text-[13px]"
            disabled={update.isPending}
          >
            <option value="">—</option>
            {ws.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <p className="pb-1 text-[11px] text-ink-3">左右站位用于过肩镜头与越轴检查</p>
      {update.isError ? <ErrorNotice className="w-full" error={update.error} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ scene --

export interface SceneSectionProps {
  scene: Scene;
  /** all shots of the scene (archived included), narrative order */
  shots: readonly Shot[];
  pendingDraft: ShotDraft | null;
  relinkOnly: boolean;
}

export const SceneSection = memo(function SceneSection({ scene, shots, pendingDraft, relinkOnly }: SceneSectionProps) {
  const ws = useWorkspace();
  const order = useSetNarrativeOrder();
  const tracked = useTrackedJob(breakdownSlot(scene.id));
  const findDraft = useDraftFinder();
  const [aiOpen, setAiOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const live = shots.filter((s) => !s.archived);
  const archivedCount = shots.length - live.length;
  const visible = relinkOnly ? live.filter((s) => s.needs_relink) : showArchived ? shots : live;
  const reorderable = !relinkOnly && !showArchived && live.length > 1 && !order.isPending;
  const lockedCount = live.filter((s) => s.locked).length;
  const totalSeconds = live.filter((s) => s.required_status !== 'waived').reduce((sum, s) => sum + (Number.isFinite(s.fields.est_seconds) ? s.fields.est_seconds : 0), 0);

  const move = (from: number, to: number) => {
    const ids = moveId(
      live.map((s) => s.id),
      from,
      to,
    );
    if (ids.every((id, i) => id === live[i]?.id)) return;
    order.mutate({ scene_id: scene.id, shot_ids: narrativeOrderIds(shots, ids) });
  };

  const onSucceeded = useCallback(
    async (job: Job) => {
      const id = await findDraft(job, 'breakdown', scene.id);
      if (id) ws.openDraft(id);
      else ws.notify(`第 ${scene.display_no} 场拆镜已完成，但没有找到对应的草案。`);
    },
    [findDraft, scene.id, scene.display_no, ws],
  );

  if (relinkOnly && visible.length === 0) return null;

  const heading = scene.paragraph_ids[0];

  return (
    <section id={sceneDomId(scene.id)} aria-labelledby={`${sceneDomId(scene.id)}-title`} className="scroll-mt-20 rounded-sheet border border-rule bg-sheet">
      <header className="flex flex-col gap-2 border-b border-rule px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
          <span className="mt-px rounded-control border border-graphite px-1.5 font-mono text-[12px] leading-5 font-medium">{scene.display_no}</span>
          <h3 id={`${sceneDomId(scene.id)}-title`} className="min-w-0 flex-1 text-[14px] leading-6 font-semibold break-words text-ink">
            {scene.heading}
          </h3>
          <span className="flex items-center gap-1.5 pt-0.5 text-xs text-ink-3 tabular-nums">
            {live.length} 镜{totalSeconds > 0 ? ` · 约 ${Math.round(totalSeconds)} 秒` : ''}
            {heading ? (
              <button
                type="button"
                onClick={() => ws.locate({ paragraph_id: heading, quote: '' })}
                className="inline-flex size-6 items-center justify-center rounded-control text-ink-3 hover:bg-sheet-sunk hover:text-ink"
                title="在左侧定位本场原文"
                aria-label={`定位第 ${scene.display_no} 场原文`}
              >
                <FileText aria-hidden className="size-3.5" />
              </button>
            ) : null}
          </span>
        </div>
        <SceneSetup scene={scene} />
        <div className="flex flex-wrap items-center gap-2">
          <Button className="h-7 px-2 text-xs" onClick={() => ws.openCreate(scene)}>
            <Plus aria-hidden className="size-3.5" />
            新建镜头
          </Button>
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => setAiOpen((o) => !o)}
            disabled={!ws.ai.enabled || tracked !== null}
            aria-expanded={aiOpen}
            title={ws.ai.reason ?? (tracked ? '本场已有拆镜任务在进行' : '按场调用模型拆镜，结果先进草案')}
          >
            <Sparkles aria-hidden className="size-3.5" />
            AI 拆镜
          </Button>
          {pendingDraft ? (
            <Button variant="primary" className="h-7 px-2 text-xs" onClick={() => ws.openDraft(pendingDraft.id)}>
              查看草案
            </Button>
          ) : null}
          {archivedCount > 0 && !relinkOnly ? (
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-3">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-3.5 accent-graphite" />
              显示已归档（{archivedCount}）
            </label>
          ) : null}
        </div>
        {!ws.ai.enabled && ws.ai.reason ? <p className="text-[11px] text-ink-3">{ws.ai.reason}</p> : null}
        {aiOpen && ws.ai.enabled ? <BreakdownForm scene={scene} lockedCount={lockedCount} liveCount={live.length} onClose={() => setAiOpen(false)} /> : null}
        <JobLine slot={breakdownSlot(scene.id)} onSucceeded={onSucceeded} />
      </header>

      {order.isError ? <ErrorNotice className="mx-3 mt-2" error={order.error} context="shot-save" /> : null}

      {visible.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-ink-3">这一场还没有镜头。{ws.ai.enabled ? '手工新建，或用 AI 拆镜生成草案。' : '点"新建镜头"手工添加。'}</p>
      ) : (
        <ol className="divide-y divide-rule" onDragLeave={() => setDragOver(null)}>
          {visible.map((s, i) => (
            <ShotRow
              key={s.id}
              shot={s}
              index={i}
              count={visible.length}
              reorderable={reorderable && !s.archived}
              dropTarget={dragFrom !== null && dragOver === i && dragOver !== dragFrom}
              onMove={move}
              onDragStart={setDragFrom}
              onDragOver={setDragOver}
              onDrop={(to) => {
                if (dragFrom !== null) move(dragFrom, to);
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
            />
          ))}
        </ol>
      )}
      {lockedCount > 0 ? (
        <p className="border-t border-rule px-4 py-1.5 text-[11px] text-ink-3">
          <Tag tone="solid" className="mr-1">
            锁定 {lockedCount}
          </Tag>
          锁定的镜头不会被 AI 重新拆镜改动。
        </p>
      ) : null}
    </section>
  );
});
