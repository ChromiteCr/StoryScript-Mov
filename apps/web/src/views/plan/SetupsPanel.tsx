import { useState } from 'react';
import { ChevronDown, ChevronUp, Plus, TriangleAlert, Wand2 } from 'lucide-react';
import type { PlanDetail, Setup, SetupDurations } from '@storyscript/contracts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, IconButton, TextInput } from '../../components/ui.tsx';
import { EmptyState, Panel } from '../../components/workspace.tsx';
import { useCreateSetup, useDeriveSetups, usePlanWrite } from '../../lib/queries-plan.ts';
import { CheckRow, Modal } from './controls.tsx';
import { setupMinutes, type PlanData } from './data.ts';

/**
 * Left, below resources: setups in shooting order. With a plan open the
 * list follows plan.result.order and up/down re-plans through the reorder
 * API (validated like everything else); narrative order is never touched.
 */

export const DEFAULT_DURATIONS: SetupDurations = { setup_min: 30, per_shot_min: 15, reset_min: 10 };

export function orderedSetups(data: PlanData, detail: PlanDetail | null): { ordered: Setup[]; idle: Setup[] } {
  const active = (s: Setup) => s.shot_ids.some((id) => {
    const shot = data.shotById.get(id);
    return shot !== undefined && shot.required_status !== 'waived';
  });
  const order = detail?.plan.result.order ?? [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const ordered = data.setups.filter(active).sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  return { ordered, idle: data.setups.filter((s) => !active(s)) };
}

export function SetupsPanel({
  data,
  detail,
  selected,
  onSelect,
}: {
  data: PlanData;
  detail: PlanDetail | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [deriving, setDeriving] = useState(false);
  const write = usePlanWrite();
  const create = useCreateSetup();
  const { ordered, idle } = orderedSetups(data, detail);
  const unplaced = new Set(detail?.plan.result.unplaced.map((u) => u.setup_id) ?? []);
  const inPlan = new Set(detail?.plan.result.order ?? []);

  const move = (index: number, delta: -1 | 1) => {
    if (!detail) return;
    const ids = ordered.map((s) => s.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    write.mutate({ kind: 'reorder', id: detail.plan.id, revision: detail.plan.revision, order: ids });
  };

  const addManual = () =>
    create.mutate(
      { location_resource_id: null, label: `新 setup ${data.setups.length + 1}`, shot_ids: [], resource_ids: [], durations: DEFAULT_DURATIONS, estimate_confirmed: false },
      { onSuccess: (s) => onSelect(s.id) },
    );

  const row = (s: Setup, index: number | null) => {
    const shots = s.shot_ids.filter((id) => data.shotById.get(id)?.required_status !== 'waived' && data.shotById.has(id)).length;
    const isSel = selected === s.id;
    return (
      <li
        key={s.id}
        className={`group flex items-center gap-1 border-l-2 pr-1 ${isSel ? 'border-l-accent bg-graphite-800' : 'border-l-transparent hover:bg-graphite-800'}`}
      >
        <button
          type="button"
          aria-pressed={isSel}
          onClick={() => onSelect(isSel ? null : s.id)}
          className="flex min-w-0 flex-1 items-start gap-2 py-1.5 pl-2 text-left"
        >
          <span className="w-5 shrink-0 pt-px text-right text-xs text-graphite-300 tabular-nums">{index === null ? '–' : index + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm text-graphite-100">{s.label}</span>
              {unplaced.has(s.id) ? <TriangleAlert aria-label="未排入" className="size-3.5 shrink-0 text-warn" /> : null}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-graphite-300 tabular-nums">
              <span>
                {shots} 镜 · {setupMinutes(s, shots)} 分
              </span>
              {s.estimate_confirmed ? null : <span className="text-warn">估算</span>}
              {detail && index !== null && !inPlan.has(s.id) ? <span>未计算</span> : null}
            </span>
          </span>
        </button>
        {index !== null && detail ? (
          <span className="flex shrink-0 items-center">
            <IconButton icon={ChevronUp} label={`上移「${s.label}」`} disabled={index === 0 || write.isPending} onClick={() => move(index, -1)} />
            <IconButton
              icon={ChevronDown}
              label={`下移「${s.label}」`}
              disabled={index === ordered.length - 1 || write.isPending}
              onClick={() => move(index, 1)}
            />
          </span>
        ) : null}
      </li>
    );
  };

  return (
    <Panel
      title={detail ? 'Setup · 拍摄顺序' : 'Setup'}
      padded={false}
      tools={
        <>
          <Button size="sm" variant="ghost" onClick={() => setDeriving(true)}>
            <Wand2 aria-hidden className="size-3.5" />
            自动分组
          </Button>
          <IconButton icon={Plus} label="手动新建 setup" onClick={addManual} disabled={create.isPending} />
        </>
      }
    >
      {write.isError ? (
        <div className="p-2">
          <ErrorNotice error={write.error} />
        </div>
      ) : null}
      {create.isError ? (
        <div className="p-2">
          <ErrorNotice error={create.error} />
        </div>
      ) : null}
      {data.setups.length === 0 ? (
        <EmptyState
          title="还没有 setup。"
          description={data.shots.length === 0 ? '先在剧本页建立镜头；有镜头后可以按场地和机位自动分组。' : `有 ${data.shots.length} 个镜头可以按场地和机位自动分组。`}
          action={
            data.shots.length > 0 ? (
              <Button size="sm" onClick={() => setDeriving(true)}>
                <Wand2 aria-hidden className="size-3.5" />
                自动分组
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col pb-2">
          {!detail ? <p className="px-3 pt-2 text-xs text-graphite-300">新建计划后，这里按拍摄顺序排列，可以上移/下移。</p> : null}
          <ul aria-label="setup 列表" className="pt-1">
            {ordered.map((s, i) => row(s, i))}
          </ul>
          {idle.length > 0 ? (
            <>
              <h3 className="px-3 pt-3 pb-1 text-xs text-graphite-300">不参与排期（没有需要拍的镜头）</h3>
              <ul>{idle.map((s) => row(s, null))}</ul>
            </>
          ) : null}
        </div>
      )}
      {deriving ? <DeriveDialog onClose={() => setDeriving(false)} hasSetups={data.setups.length > 0} /> : null}
    </Panel>
  );
}

function DeriveDialog({ onClose, hasSetups }: { onClose: () => void; hasSetups: boolean }) {
  const derive = useDeriveSetups();
  const [keep, setKeep] = useState(true);
  const [d, setD] = useState({ setup_min: String(DEFAULT_DURATIONS.setup_min), per_shot_min: String(DEFAULT_DURATIONS.per_shot_min), reset_min: String(DEFAULT_DURATIONS.reset_min) });
  const nums = { setup_min: Number(d.setup_min), per_shot_min: Number(d.per_shot_min), reset_min: Number(d.reset_min) };
  const valid = Object.values(nums).every((n) => Number.isFinite(n) && n >= 0) && nums.per_shot_min > 0;
  const fields: [keyof typeof d, string][] = [
    ['setup_min', '准备（分钟）'],
    ['per_shot_min', '每镜（分钟）'],
    ['reset_min', '复位（分钟）'],
  ];
  return (
    <Modal
      title="自动分组"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!valid} busy={derive.isPending} onClick={() => derive.mutate({ keep_edited: keep, default_durations: nums }, { onSuccess: onClose })}>
            开始分组
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-graphite-300">
          把未归档、未豁免的镜头按"场地 + 机位角度 + 第一个人物的朝向"分组。新 setup 的工时是估算，批准计划前需要逐个确认。
        </p>
        <div className="grid grid-cols-3 gap-2">
          {fields.map(([k, label]) => (
            <Field key={k} label={label}>
              {({ id }) => (
                <TextInput id={id} inputMode="numeric" className="tabular-nums" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
              )}
            </Field>
          ))}
        </div>
        {hasSetups ? (
          <CheckRow checked={keep} onChange={setKeep} hint={keep ? '只重建自动生成、之后没改过的 setup。' : '所有 setup 都会重建，手改的工时和手建的 setup 会丢失。'}>
            保留我建过或改过的 setup
          </CheckRow>
        ) : null}
        {derive.isError ? <ErrorNotice error={derive.error} /> : null}
      </div>
    </Modal>
  );
}
