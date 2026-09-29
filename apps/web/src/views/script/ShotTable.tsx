import { memo, useCallback, useMemo, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Job, Scene, Shot } from '@storyscript/contracts';
import { FileSearch, Plus, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { breakdownSlot, useTrackedJob } from '../../lib/jobs.ts';
import { useSetNarrativeOrder } from '../../lib/queries.ts';
import { groupShotsByScene, moveId, narrativeOrderIds } from '../../lib/shots.ts';
import { pageHref } from '../../lib/stages.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, IconButton, Notice, Spinner } from '../../components/ui.tsx';
import { EmptyState, Panel } from '../../components/workspace.tsx';
import { JobLine, useDraftFinder } from './JobLine.tsx';
import { ShotRow } from './ShotRow.tsx';
import { sceneGroupDomId, useWorkspace } from './context.ts';

// ------------------------------------------------------------------ scene --

interface SceneGroupProps {
  scene: Scene;
  /** live shots of the scene, narrative order */
  shots: readonly Shot[];
  relinkOnly: boolean;
  selectedShotId: string | null;
}

const SceneGroup = memo(function SceneGroup({ scene, shots, relinkOnly, selectedShotId }: SceneGroupProps) {
  const ws = useWorkspace();
  const order = useSetNarrativeOrder();
  const tracked = useTrackedJob(breakdownSlot(scene.id));
  const findDraft = useDraftFinder();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const visible = relinkOnly ? shots.filter((s) => s.needs_relink) : shots;
  const reorderable = !relinkOnly && shots.length > 1 && !order.isPending;
  const totalSeconds = shots
    .filter((s) => s.required_status !== 'waived')
    .reduce((sum, s) => sum + (Number.isFinite(s.fields.est_seconds) ? s.fields.est_seconds : 0), 0);
  const pendingDraft = ws.pendingDraftByScene.get(scene.id) ?? null;

  const move = (from: number, to: number) => {
    const ids = moveId(
      shots.map((s) => s.id),
      from,
      to,
    );
    if (ids.every((id, i) => id === shots[i]?.id)) return;
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

  const aiTitle = ws.ai.reason ?? (tracked ? '本场已有拆镜任务' : '按场调用模型拆镜：在检查器里选手法和镜头上限，结果先进草案');

  return (
    <section id={sceneGroupDomId(scene.id)} aria-labelledby={`${sceneGroupDomId(scene.id)}-title`} className="scroll-mt-0 border-b border-graphite-800 last:border-b-0">
      <header className="sticky top-0 z-10 flex min-h-9 items-center gap-2 border-b border-graphite-800 bg-graphite-900 py-1 pr-1 pl-3">
        <button
          type="button"
          onClick={() => ws.selectScene(scene, { open: true })}
          className="flex min-w-0 flex-1 items-baseline gap-2 rounded-control text-left"
          title="在检查器里查看场次设置与 AI 拆镜"
        >
          <span className="shrink-0 text-xs text-graphite-300 tabular-nums">{scene.display_no}</span>
          <h3 id={`${sceneGroupDomId(scene.id)}-title`} className="min-w-0 truncate text-sm font-medium text-graphite-100">
            {scene.heading}
          </h3>
          <span className="shrink-0 text-xs text-graphite-300 tabular-nums">
            {shots.length} 镜{totalSeconds > 0 ? ` · 约 ${Math.round(totalSeconds)} 秒` : ''}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {pendingDraft ? (
            <Button size="sm" onClick={() => ws.openDraft(pendingDraft.id)} title="模型的拆镜结果在草案里，勾选后才写入镜头表">
              <FileSearch aria-hidden className="size-3" />
              审阅草案
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => ws.selectScene(scene, { focus: 'breakdown' })}
            disabled={!ws.ai.enabled || tracked !== null}
            title={aiTitle}
          >
            <Sparkles aria-hidden className="size-3" />
            <span className="max-md:sr-only">AI 拆镜</span>
          </Button>
          <IconButton icon={Plus} label={`在第 ${scene.display_no} 场新建手工镜头`} onClick={() => ws.openCreate(scene)} />
          <IconButton icon={SlidersHorizontal} label={`第 ${scene.display_no} 场设置`} title="场次设置：左右站位、地点" onClick={() => ws.selectScene(scene, { focus: 'setup' })} />
        </div>
      </header>

      {tracked ? (
        <div className="px-3 pt-2">
          <JobLine slot={breakdownSlot(scene.id)} onSucceeded={onSucceeded} onOpenDraft={ws.openDraft} />
        </div>
      ) : null}
      {order.isError ? <ErrorNotice className="mx-3 mt-2" error={order.error} context="shot-save" /> : null}

      {visible.length === 0 ? (
        <p className="px-3 py-3 text-sm text-graphite-300">
          这一场还没有镜头。{ws.ai.enabled ? '手工新建，或用 AI 拆镜生成草案。' : '点 + 手工新建。'}
        </p>
      ) : (
        <ol className="divide-y divide-graphite-800" onDragLeave={() => setDragOver(null)}>
          {visible.map((s, i) => (
            <ShotRow
              key={s.id}
              shot={s}
              index={i}
              count={visible.length}
              selected={s.id === selectedShotId}
              reorderable={reorderable}
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
    </section>
  );
});

// ------------------------------------------------------------------ table --

export interface ShotTableProps {
  shotsQuery: UseQueryResult<Shot[]>;
  relinkOnly: boolean;
  notice: string | null;
  onDismissNotice: () => void;
}

/** Shot table grouped by scene (narrative order). Selection opens the shot in the inspector. */
export function ShotTable({ shotsQuery, relinkOnly, notice, onDismissNotice }: ShotTableProps) {
  const ws = useWorkspace();
  const live = useMemo(() => (shotsQuery.data ?? []).filter((s) => !s.archived), [shotsQuery.data]);
  const grouped = useMemo(() => groupShotsByScene(live), [live]);
  const sceneIds = useMemo(() => new Set(ws.script.scenes.map((s) => s.id)), [ws.script.scenes]);
  const orphans = useMemo(() => live.filter((s) => !sceneIds.has(s.scene_id)), [live, sceneIds]);
  const selectedShotId = ws.inspector?.kind === 'shot' ? ws.inspector.shotId : null;

  return (
    <Panel title={`镜头表 · ${live.length}`} padded={false}>
      {notice ? (
        <div className="flex items-start gap-1 border-b border-graphite-800 p-2">
          <Notice tone="info" role="status" title={notice} className="min-w-0 flex-1" />
          <IconButton icon={X} label="关闭提示" onClick={onDismissNotice} className="mt-1.5" />
        </div>
      ) : null}
      {!ws.ai.enabled && ws.ai.reason ? (
        <div className="border-b border-graphite-800 p-2">
          <Notice tone="info" title="AI 拆镜和实体抽取已置灰">
            {ws.ai.reason}{' '}
            <a href={pageHref('settings')} className="text-graphite-100 underline underline-offset-2 hover:decoration-2">
              前往设置
            </a>
          </Notice>
        </div>
      ) : null}

      {shotsQuery.isPending ? (
        <div className="p-3">
          <Spinner label="正在读取镜头…" />
        </div>
      ) : shotsQuery.isError ? (
        <div className="flex flex-col items-start gap-2 p-3">
          <ErrorNotice error={shotsQuery.error} />
          <Button onClick={() => void shotsQuery.refetch()}>重试</Button>
        </div>
      ) : ws.script.scenes.length === 0 ? (
        <EmptyState title="当前版本没有场次。" description="导入新版本时，在预览里把场次标题行标为「场」。" />
      ) : (
        <>
          {ws.script.scenes.map((scene) => (
            <SceneGroup key={scene.id} scene={scene} shots={grouped.get(scene.id) ?? []} relinkOnly={relinkOnly} selectedShotId={selectedShotId} />
          ))}
          {orphans.length > 0 ? (
            <div className="p-3">
              <Notice tone="warn" title={`${orphans.length} 个镜头不在当前版本的场次里`}>
                它们所属的场次在新版本中没有对应（{orphans.map((s) => s.code).join('、')}），这里暂不显示，数据仍然保留。
              </Notice>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
