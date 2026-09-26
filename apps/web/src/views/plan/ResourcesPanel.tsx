import { useState } from 'react';
import { MapPin, Plus, Trash2, User, Wrench, type LucideIcon } from 'lucide-react';
import type { Resource, ResourceType } from '@storyscript/contracts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, IconButton, Notice, Tag, TextInput } from '../../components/ui.tsx';
import { EmptyState, Panel } from '../../components/workspace.tsx';
import { isApiClientError } from '../../lib/api.ts';
import { PLAN_ERROR_COPY, RESOURCE_TYPE_LABEL } from '../../lib/labels-plan.ts';
import { useDeleteResource, useSaveResource } from '../../lib/queries-plan.ts';
import { CheckRow, Modal, TimeField } from './controls.tsx';
import { fromLocalWindow, toLocalWindow, uncastCharacters, windowLabel, type LocalWindow, type PlanData } from './data.ts';

/**
 * Left panel: performers, locations and equipment with their availability
 * (FR-06). Rows open the edit dialog; windows are typed as local HH:mm in
 * the project time zone and converted with core localWindowToUtc.
 */

const TYPES: ResourceType[] = ['performer', 'location', 'equipment'];
const TYPE_ICON: Record<ResourceType, LucideIcon> = { performer: User, location: MapPin, equipment: Wrench };

export function ResourcesPanel({ data, refDate }: { data: PlanData; refDate: string }) {
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const uncast = uncastCharacters(data);
  const tz = data.project.timezone;
  const entityName = new Map(data.entities.map((e) => [e.id, e.name]));

  return (
    <Panel
      title="资源"
      padded={false}
      tools={<IconButton icon={Plus} label="新增资源" onClick={() => setEditing('new')} />}
    >
      {uncast.length > 0 ? (
        <div className="p-2">
          <Notice tone="warn" title={`${uncast.length} 个角色还没有演员`}>
            {uncast.map((e) => e.name).join('、')}：没有演员的角色不受时间窗约束。
          </Notice>
        </div>
      ) : null}
      {data.resources.length === 0 ? (
        <EmptyState
          title="还没有资源。"
          description="添加演员和场地，填写当天的可用时间；演员勾选他演的角色，场地勾选对应的地点。"
          action={
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden className="size-3.5" />
              新增资源
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col pb-2">
          {TYPES.map((type) => {
            const list = data.resources.filter((r) => r.type === type);
            if (list.length === 0) return null;
            const Icon = TYPE_ICON[type];
            return (
              <section key={type} aria-label={RESOURCE_TYPE_LABEL[type]}>
                <h3 className="flex h-7 items-center gap-1.5 px-3 text-xs font-medium text-graphite-300">
                  <Icon aria-hidden className="size-3.5" />
                  {RESOURCE_TYPE_LABEL[type]}
                  <span className="tabular-nums">{list.length}</span>
                </h3>
                <ul>
                  {list.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setEditing(r)}
                        className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-graphite-800"
                      >
                        <span className="flex w-full items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-graphite-100">{r.name}</span>
                          {r.confirmed ? null : <Tag>未确认</Tag>}
                        </span>
                        {r.cast_character_ids.length > 0 ? (
                          <span className="truncate text-xs text-graphite-300">
                            {type === 'performer' ? '饰 ' : '对应 '}
                            {r.cast_character_ids.map((id) => entityName.get(id) ?? '?').join('、')}
                          </span>
                        ) : null}
                        <span className="text-xs text-graphite-300 tabular-nums">
                          {r.windows.length === 0 ? '没有填写可用时间' : r.windows.map((w) => windowLabel(w, tz, refDate)).join('，')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {editing ? <ResourceDialog data={data} resource={editing === 'new' ? null : editing} refDate={refDate} onClose={() => setEditing(null)} /> : null}
    </Panel>
  );
}

// ------------------------------------------------------------------ dialog ---

function ResourceDialog({ data, resource, refDate, onClose }: { data: PlanData; resource: Resource | null; refDate: string; onClose: () => void }) {
  const tz = data.project.timezone;
  const save = useSaveResource();
  const remove = useDeleteResource();
  const [type, setType] = useState<ResourceType>(resource?.type ?? 'performer');
  const [name, setName] = useState(resource?.name ?? '');
  const [windows, setWindows] = useState<LocalWindow[]>(
    resource ? resource.windows.map((w) => toLocalWindow(w, tz)) : [{ date: refDate, start: '08:00', end: '20:00' }],
  );
  const [cast, setCast] = useState<string[]>(resource?.cast_character_ids ?? []);
  const [confirmed, setConfirmed] = useState(resource?.confirmed ?? true);
  const [problem, setProblem] = useState<string | null>(null);

  const castType = type === 'performer' ? 'character' : type === 'location' ? 'location' : null;
  const castable = castType ? data.entities.filter((e) => e.type === castType) : [];

  const submit = () => {
    if (!name.trim()) return setProblem('请填写名称');
    const utc = windows.map((w) => fromLocalWindow(w, tz));
    const bad = utc.findIndex((w) => w === null);
    if (bad >= 0) return setProblem(`第 ${bad + 1} 个时间段不完整`);
    setProblem(null);
    save.mutate(
      {
        id: resource?.id ?? null,
        input: {
          type,
          name: name.trim(),
          windows: utc.filter((w) => w !== null),
          cast_character_ids: castType ? cast.filter((id) => castable.some((e) => e.id === id)) : [],
          confirmed,
        },
      },
      { onSuccess: onClose },
    );
  };

  const inUse =
    remove.error && isApiClientError(remove.error) && remove.error.status === 409
      ? ((remove.error.details as { setups?: { label: string }[] } | undefined)?.setups ?? [])
      : null;

  return (
    <Modal
      title={resource ? `编辑资源：${resource.name}` : '新增资源'}
      onClose={onClose}
      wide
      footer={
        <>
          {resource ? (
            <Button variant="ghost" className="mr-auto" busy={remove.isPending} onClick={() => remove.mutate(resource.id, { onSuccess: onClose })}>
              <Trash2 aria-hidden className="size-3.5" />
              删除
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-graphite-100">类型</legend>
          <div className="flex gap-1" role="radiogroup">
            {TYPES.map((t) => (
              <label
                key={t}
                className={
                  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border px-3 text-sm ' +
                  (type === t ? 'border-graphite-300 bg-graphite-700 text-graphite-100' : 'border-graphite-700 bg-graphite-800 text-graphite-300 hover:border-graphite-500')
                }
              >
                <input type="radio" name="resource-type" className="sr-only" checked={type === t} onChange={() => setType(t)} />
                {RESOURCE_TYPE_LABEL[t]}
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="名称">
          {({ id }) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'performer' ? '演员姓名' : type === 'location' ? '实景名称' : '设备名称'} />}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-graphite-100">可用时间</legend>
          <p className="text-xs text-graphite-300">按项目时区 {tz} 填写。结束不晚于开始时，按跨午夜到次日处理。</p>
          {windows.length === 0 ? <p className="text-sm text-graphite-300">没有时间段：已确认的资源会被视为当天不可用。</p> : null}
          {windows.map((w, i) => {
            const overnight = w.start && w.end && w.end <= w.start;
            return (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <input
                  type="date"
                  aria-label={`第 ${i + 1} 段日期`}
                  value={w.date}
                  onChange={(e) => setWindows(windows.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
                  className="h-7 w-full rounded-control border border-graphite-700 bg-graphite-800 px-1.5 text-sm text-graphite-100 tabular-nums hover:border-graphite-500 sm:w-auto"
                />
                <TimeField label={`第 ${i + 1} 段开始`} value={w.start} onChange={(v) => setWindows(windows.map((x, j) => (j === i ? { ...x, start: v } : x)))} />
                <span aria-hidden className="text-graphite-300">
                  –
                </span>
                <TimeField label={`第 ${i + 1} 段结束`} value={w.end} onChange={(v) => setWindows(windows.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
                {overnight ? <Tag>次日</Tag> : null}
                <IconButton icon={Trash2} label={`删除第 ${i + 1} 段`} onClick={() => setWindows(windows.filter((_, j) => j !== i))} />
              </div>
            );
          })}
          <div>
            <Button
              size="sm"
              onClick={() => setWindows([...windows, { date: windows.at(-1)?.date ?? refDate, start: '08:00', end: '20:00' }])}
            >
              <Plus aria-hidden className="size-3.5" />
              添加时间段
            </Button>
          </div>
        </fieldset>

        {castType ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-graphite-100">{type === 'performer' ? '饰演的角色' : '对应的地点'}</legend>
            {castable.length === 0 ? (
              <p className="text-sm text-graphite-300">
                {type === 'performer' ? '还没有角色：先在剧本页建立角色，再回来选角。' : '还没有地点实体：先在剧本页建立地点，并把它设为场景的地点。'}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {castable.map((e) => (
                  <CheckRow
                    key={e.id}
                    checked={cast.includes(e.id)}
                    onChange={(v) => setCast(v ? [...cast, e.id] : cast.filter((x) => x !== e.id))}
                    hint={e.aliases.length > 0 ? e.aliases.join('、') : undefined}
                  >
                    {e.name}
                  </CheckRow>
                ))}
              </div>
            )}
          </fieldset>
        ) : null}

        <CheckRow checked={confirmed} onChange={setConfirmed} hint="未确认的资源会阻止批准计划。">
          已确认（时间和人选都已落实）
        </CheckRow>

        {problem ? <Notice tone="danger" title={problem} /> : null}
        {save.isError ? <ErrorNotice error={save.error} /> : null}
        {inUse ? (
          <Notice tone="danger" title={PLAN_ERROR_COPY.resourceInUse}>
            先在这些 setup 里换掉它：{inUse.map((s) => `「${s.label}」`).join('、')}
          </Notice>
        ) : remove.isError ? (
          <ErrorNotice error={remove.error} />
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
