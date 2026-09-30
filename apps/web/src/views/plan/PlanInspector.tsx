import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import type { ConstraintType, PlanDetail, Setup } from '@storyscript/contracts';
import { localToUtc, utcToLocal } from '@storyscript/core';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { RebaseNotice } from '../../components/RebaseNotice.tsx';
import { Button, IconButton, SelectInput, Tag, TextInput } from '../../components/ui.tsx';
import { EmptyState, Inspector, InspectorGroup, InspectorRow } from '../../components/workspace.tsx';
import { useChangedBy } from '../../lib/collab.ts';
import { isRevisionConflict } from '../../lib/errors.ts';
import { CONSTRAINT_TYPE_LABEL, constraintText } from '../../lib/labels-plan.ts';
import { planKeys, useCreateConstraint, useDeleteConstraint, useDeleteSetup, useUpdateSetup } from '../../lib/queries-plan.ts';
import { setupCommit, setupForm, type DurKey } from '../../lib/setup-form.ts';
import { stableKey } from '../../lib/stable.ts';
import { useRebasedForm } from '../../lib/useRebasedForm.ts';
import { localTime } from '../../lib/print-plan.ts';
import { CheckRow, TimeField } from './controls.tsx';
import { setupMinutes, type PlanData } from './data.ts';

/**
 * Right-hand inspector: the selected setup (label, location, durations and
 * their confirmation, equipment, shots) and its constraints. Checkboxes and
 * selects commit at once; text and numbers commit on blur or Enter.
 */

export function PlanInspector({
  data,
  detail,
  setupId,
  onSelect,
  planDate,
}: {
  data: PlanData;
  detail: PlanDetail | null;
  setupId: string | null;
  onSelect: (id: string | null) => void;
  planDate: string;
}) {
  const setup = setupId ? data.setupById.get(setupId) : undefined;
  if (!setup) {
    return (
      <EmptyState
        title="选中左侧的一个 setup。"
        description="在这里确认工时、调整包含的镜头，并添加先后、时间和锁定约束。"
      />
    );
  }
  return (
    <Inspector>
      <SetupEditor key={setup.id} data={data} setup={setup} onDeleted={() => onSelect(null)} />
      <ConstraintEditor data={data} setup={setup} planDate={planDate} detail={detail} />
    </Inspector>
  );
}

// ------------------------------------------------------------------ setup ---

const DUR_FIELDS: [DurKey, string][] = [
  ['setup_min', '准备'],
  ['per_shot_min', '每镜'],
  ['reset_min', '复位'],
];

/**
 * The name and the durations are typed and committed on blur or Enter; a
 * teammate's save of the same setup never replaces what is being typed
 * (useRebasedForm). Selects and checkboxes commit at once, naming the
 * revision on screen: a teammate's newer save answers 409, not an overwrite.
 */
function SetupEditor({ data, setup, onDeleted }: { data: PlanData; setup: Setup; onDeleted: () => void }) {
  const qc = useQueryClient();
  const update = useUpdateSetup();
  const remove = useDeleteSetup();
  const by = useChangedBy(['plan']);
  const form = useRebasedForm(setupForm(setup), { revision: setup.revision, by });
  const [adding, setAdding] = useState('');

  type Patch = Parameters<typeof update.mutate>[0]['input'];
  // One save at a time, each naming the revision the last one returned: a name typed and a box ticked
  // in quick succession are two saves of ours, not a teammate's change.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const saved = useRef<number | undefined>(setup.revision);
  const sending = useRef<Set<string>>(new Set());
  const send = (input: Patch, revision: number | undefined) => {
    chain.current = chain.current.then(async () => {
      const expected = revision === undefined ? undefined : Math.max(revision, saved.current ?? revision);
      try {
        const next = await update.mutateAsync({ id: setup.id, input: { ...input, expected_revision: expected } });
        saved.current = next.revision ?? saved.current;
        form.acknowledge(setupForm(next), next.revision);
      } catch {
        // shown through update.error
      }
    });
  };
  const patch = (input: Patch) => send(input, setup.revision);

  /** Blur or Enter in the name or a duration; Enter and the blur after it send it once. */
  const commit = () => {
    if (form.conflict) return; // the person picks 用他的 or 保留我的 first
    const { input, draft } = setupCommit(form.seed, form.value);
    form.setValue(draft);
    if (!input) return;
    const key = stableKey(input);
    if (sending.current.has(key)) return;
    sending.current.add(key);
    send(input, form.expectedRevision);
    void chain.current.then(() => sending.current.delete(key));
  };

  const refresh = () => {
    update.reset();
    form.takeTheirs();
    void qc.invalidateQueries({ queryKey: planKeys.all });
  };

  const shots = setup.shot_ids.map((id) => data.shotById.get(id)).filter((s) => s !== undefined);
  const active = shots.filter((s) => s.required_status !== 'waived').length;
  const available = data.shots.filter((s) => s.setup_id !== setup.id && s.required_status !== 'waived');
  const locations = data.resources.filter((r) => r.type === 'location');
  const equipment = data.resources.filter((r) => r.type === 'equipment');

  return (
    <InspectorGroup
      title="Setup"
      actions={
        <Button size="sm" variant="ghost" busy={remove.isPending} onClick={() => remove.mutate(setup.id, { onSuccess: onDeleted })}>
          <Trash2 aria-hidden className="size-3.5" />
          删除
        </Button>
      }
      note={
        <>
          <RebaseNotice
            className="mb-2"
            conflict={form.conflict}
            refused={isRevisionConflict(update.error)}
            onTheirs={() => {
              update.reset();
              form.takeTheirs();
            }}
            onMine={() => {
              // the person's version wins on purpose: save it against the revision on screen now
              update.reset();
              form.keepMine();
              const { input, draft } = setupCommit(setupForm(setup), form.value);
              form.setValue(draft);
              if (input) patch(input);
            }}
            onRefresh={refresh}
          />
          {update.isError && !isRevisionConflict(update.error) ? <ErrorNotice error={update.error} className="mb-2" /> : null}
          {remove.isError ? <ErrorNotice error={remove.error} className="mb-2" /> : null}
        </>
      }
    >
      <InspectorRow label="名称">
        <TextInput
          aria-label="setup 名称"
          value={form.value.label}
          onChange={(e) => form.setValue((v) => ({ ...v, label: e.target.value }))}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      </InspectorRow>
      <InspectorRow label="场地">
        <SelectInput
          aria-label="场地"
          value={setup.location_resource_id ?? ''}
          onChange={(e) => patch({ location_resource_id: e.target.value || null })}
        >
          <option value="">不指定</option>
          {locations.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </SelectInput>
      </InspectorRow>
      <InspectorRow label="工时（分钟）">
        <div className="grid grid-cols-3 gap-1">
          {DUR_FIELDS.map(([k, name]) => (
            <label key={k} className="flex flex-col gap-0.5">
              <span className="text-xs text-graphite-300">{name}</span>
              <TextInput
                inputMode="decimal"
                className="px-1.5 tabular-nums"
                value={form.value[k]}
                onChange={(e) => form.setValue((v) => ({ ...v, [k]: e.target.value }))}
                onBlur={commit}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
              />
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-graphite-300 tabular-nums">
          共 {setupMinutes(setup, active)} 分钟（{active} 个镜头）
        </p>
      </InspectorRow>
      <InspectorRow label="工时确认">
        <div className="flex flex-col gap-1">
          <CheckRow checked={setup.estimate_confirmed} onChange={(v) => patch({ estimate_confirmed: v })}>
            已确认
          </CheckRow>
          {setup.estimate_confirmed ? null : <span className="text-xs text-warn">仍是估算：批准前需要确认</span>}
        </div>
      </InspectorRow>
      {equipment.length > 0 ? (
        <InspectorRow label="设备">
          <div className="flex flex-col gap-1">
            {equipment.map((r) => (
              <CheckRow
                key={r.id}
                checked={setup.resource_ids.includes(r.id)}
                onChange={(v) => patch({ resource_ids: v ? [...setup.resource_ids, r.id] : setup.resource_ids.filter((x) => x !== r.id) })}
              >
                {r.name}
              </CheckRow>
            ))}
          </div>
        </InspectorRow>
      ) : null}
      <InspectorRow label="镜头">
        <div className="flex flex-col gap-1">
          {shots.length === 0 ? <span className="text-xs text-graphite-300">没有镜头：这个 setup 不会排进计划。</span> : null}
          <ul className="flex flex-col">
            {shots.map((s) => (
              <li key={s.id} className="flex items-center gap-1">
                <span className="w-14 shrink-0 text-xs text-graphite-300 tabular-nums">
                  {data.sceneNo(s.scene_id)}-{s.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-graphite-100" title={s.fields.action}>
                  {s.fields.action || '（无动作描述）'}
                </span>
                {s.required_status === 'waived' ? <Tag>豁免</Tag> : null}
                <IconButton icon={X} label={`从 setup 移除 ${s.code}`} onClick={() => patch({ shot_ids: setup.shot_ids.filter((id) => id !== s.id) })} />
              </li>
            ))}
          </ul>
          {available.length > 0 ? (
            <div className="flex gap-1">
              <SelectInput aria-label="添加镜头" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">添加镜头…</option>
                {available.map((s) => (
                  <option key={s.id} value={s.id}>
                    {data.sceneNo(s.scene_id)}-{s.code} {s.fields.action.slice(0, 16)}
                    {s.setup_id ? '（移出原 setup）' : ''}
                  </option>
                ))}
              </SelectInput>
              <IconButton
                icon={Plus}
                label="添加所选镜头"
                disabled={!adding}
                onClick={() => {
                  patch({ shot_ids: [...setup.shot_ids, adding] });
                  setAdding('');
                }}
              />
            </div>
          ) : null}
        </div>
      </InspectorRow>
    </InspectorGroup>
  );
}

// ------------------------------------------------------------- constraints ---

const TYPES: ConstraintType[] = ['before', 'not_before', 'not_after', 'locked_block'];

function ConstraintEditor({ data, setup, planDate, detail }: { data: PlanData; setup: Setup; planDate: string; detail: PlanDetail | null }) {
  const create = useCreateConstraint();
  const remove = useDeleteConstraint();
  const tz = data.project.timezone;
  const [type, setType] = useState<ConstraintType>('before');
  const [other, setOther] = useState('');
  const [at, setAt] = useState('12:00');
  const [start, setStart] = useState('12:00');
  const [end, setEnd] = useState('13:00');
  const [confirmed, setConfirmed] = useState(true);

  const mine = data.constraints.filter((c) => (c.type === 'before' ? c.a_setup_id === setup.id || c.b_setup_id === setup.id : c.setup_id === setup.id));
  const others = data.setups.filter((s) => s.id !== setup.id);
  const time = (iso: string) => localTime(iso, tz, planDate);
  // Times are on the plan's date; before the crew call means past midnight.
  const callTime = detail ? utcToLocal(detail.plan.day_start_utc, tz).time : '00:00';
  const utc = (hhmm: string) => localToUtc(planDate, hhmm, tz, hhmm < callTime ? 1 : 0);

  const add = () => {
    const base = { confirmed };
    if (type === 'before') {
      if (!other) return;
      create.mutate({ type, a_setup_id: setup.id, b_setup_id: other, ...base });
    } else if (type === 'locked_block') {
      const s = utc(start);
      let e = utc(end);
      if (Date.parse(e) <= Date.parse(s)) e = localToUtc(planDate, end, tz, (start < callTime ? 1 : 0) + 1);
      create.mutate({ type, setup_id: setup.id, start_utc: s, end_utc: e, ...base });
    } else {
      create.mutate({ type, setup_id: setup.id, at_utc: utc(at), ...base });
    }
  };

  return (
    <InspectorGroup
      title="约束"
      note={
        <>
          {mine.length === 0 ? <p className="text-xs text-graphite-300">没有约束。</p> : null}
          <ul className="flex flex-col gap-1">
            {mine.map((c) => (
              <li key={c.id} className="flex items-start gap-1">
                <span className="min-w-0 flex-1 text-xs leading-5 text-graphite-100">
                  {constraintText(c, data.names, time)}
                  {c.confirmed ? null : <span className="ml-1 text-graphite-300">（未确认，不参与排期）</span>}
                </span>
                <IconButton icon={Trash2} label="删除约束" onClick={() => remove.mutate(c.id)} disabled={remove.isPending} />
              </li>
            ))}
          </ul>
          {remove.isError ? <ErrorNotice error={remove.error} className="mt-2" /> : null}
        </>
      }
    >
      <InspectorRow label="类型">
        <SelectInput aria-label="约束类型" value={type} onChange={(e) => setType(e.target.value as ConstraintType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {CONSTRAINT_TYPE_LABEL[t]}
            </option>
          ))}
        </SelectInput>
      </InspectorRow>
      {type === 'before' ? (
        <InspectorRow label="须先于">
          <SelectInput aria-label="须在哪个 setup 之前拍完" value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">选择 setup…</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectInput>
        </InspectorRow>
      ) : type === 'locked_block' ? (
        <InspectorRow label="时段">
          <div className="flex items-center gap-1">
            <TimeField label="锁定开始" value={start} onChange={setStart} className="flex-1" />
            <span aria-hidden className="text-graphite-300">
              –
            </span>
            <TimeField label="锁定结束" value={end} onChange={setEnd} className="flex-1" />
          </div>
        </InspectorRow>
      ) : (
        <InspectorRow label={type === 'not_before' ? '最早开始' : '最晚结束'}>
          <TimeField label="时间" value={at} onChange={setAt} className="w-full" />
        </InspectorRow>
      )}
      <InspectorRow label="确认">
        <CheckRow checked={confirmed} onChange={setConfirmed}>
          已确认
        </CheckRow>
      </InspectorRow>
      <InspectorRow label="">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-graphite-300">
            时间按 {planDate}（{tz}）换算{detail ? `，早于开工 ${callTime} 视为次日` : ''}。
          </p>
          <div>
            <Button size="sm" onClick={add} busy={create.isPending} disabled={type === 'before' && !other}>
              <Plus aria-hidden className="size-3.5" />
              添加约束
            </Button>
          </div>
          {create.isError ? <ErrorNotice error={create.error} /> : null}
        </div>
      </InspectorRow>
    </InspectorGroup>
  );
}
