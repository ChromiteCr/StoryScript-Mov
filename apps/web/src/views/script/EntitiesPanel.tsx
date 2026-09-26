import { useCallback, useState, type FormEvent } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Entity, EntityType, Job } from '@storyscript/contracts';
import { Check, ChevronDown, ChevronRight, Pencil, Plus, Sparkles } from 'lucide-react';
import { formatAliases, parseAliasInput } from '../../lib/drafts.ts';
import { ENTITIES_SLOT, trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { ENTITY_TYPE_LABEL } from '../../lib/labels.ts';
import { useCreateEntity, useDrafts, useExtractEntities, useUpdateEntity } from '../../lib/queries.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, IconButton, SelectInput, Spinner, TextInput } from '../../components/ui.tsx';
import { EmptyState, Panel } from '../../components/workspace.tsx';
import { JobLine, useDraftFinder } from './JobLine.tsx';
import { useWorkspace } from './context.ts';

const TYPES: readonly EntityType[] = ['character', 'location', 'prop'];

function EntityEditor({ entity, onDone }: { entity: Entity; onDone: () => void }) {
  const update = useUpdateEntity();
  const [name, setName] = useState(entity.name);
  const [aliases, setAliases] = useState(formatAliases(entity.aliases));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') return;
    update.mutate({ id: entity.id, input: { name: name.trim(), aliases: parseAliasInput(aliases) } }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5 px-3 py-2">
      <TextInput aria-label={`${entity.alias} 的名称`} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <TextInput aria-label="别名，用顿号或逗号分隔" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="别名，用顿号分隔" />
      {update.isError ? <ErrorNotice error={update.error} /> : null}
      <div className="flex gap-1.5">
        <Button type="submit" variant="primary" size="sm" busy={update.isPending} disabled={name.trim() === ''}>
          保存
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          取消
        </Button>
      </div>
    </form>
  );
}

function EntityRow({ entity }: { entity: Entity }) {
  const update = useUpdateEntity();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="bg-graphite-800/60">
        <EntityEditor entity={entity} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-2 py-1 pr-1 pl-3 hover:bg-graphite-800/60">
      <span className="w-6 shrink-0 pt-px text-xs text-graphite-300 tabular-nums">{entity.alias}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words text-graphite-100">{entity.name}</p>
        {entity.aliases.length > 0 ? <p className="text-xs break-words text-graphite-300">又称 {formatAliases(entity.aliases)}</p> : null}
        {update.isError ? <p className="text-xs text-graphite-100">保存失败，请重试。</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {/* the status lives in the dot; the button reads as the action it performs */}
        <button
          type="button"
          onClick={() => update.mutate({ id: entity.id, input: { confirmed: !entity.confirmed } })}
          disabled={update.isPending}
          aria-pressed={entity.confirmed}
          aria-label={entity.confirmed ? `${entity.name} 已确认，取消确认` : `确认 ${entity.name}`}
          className={
            'inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-xs disabled:opacity-50 ' +
            (entity.confirmed
              ? 'text-graphite-300 hover:bg-graphite-700 hover:text-graphite-100'
              : 'border border-graphite-700 text-graphite-100 hover:border-graphite-500 hover:bg-graphite-700')
          }
          title={entity.confirmed ? '已确认，点击取消确认' : 'AI 抽取的条目待你确认：核对名称和别名后点击确认'}
        >
          {entity.confirmed ? <Check aria-hidden className="size-3 text-ok" /> : <span aria-hidden className="size-1.5 rounded-full bg-warn" />}
          {entity.confirmed ? '已确认' : '确认'}
        </button>
        <IconButton icon={Pencil} label={`编辑 ${entity.name}`} title="改名 / 编辑别名" onClick={() => setEditing(true)} />
      </div>
    </li>
  );
}

function AddEntityForm({ onDone }: { onDone: () => void }) {
  const create = useCreateEntity();
  const [type, setType] = useState<EntityType>('character');
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') return;
    create.mutate(
      { type, name: name.trim(), aliases: parseAliasInput(aliases) },
      {
        onSuccess: () => {
          setName('');
          setAliases('');
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5 border-b border-graphite-800 bg-graphite-800/40 p-3">
      <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-1.5">
        <SelectInput aria-label="类型" value={type} onChange={(e) => setType(e.target.value as EntityType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {ENTITY_TYPE_LABEL[t]}
            </option>
          ))}
        </SelectInput>
        <TextInput aria-label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" autoFocus />
      </div>
      <TextInput aria-label="别名" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="别名，用顿号分隔（可不填）" />
      {create.isError ? <ErrorNotice error={create.error} /> : null}
      <div className="flex gap-1.5">
        <Button type="submit" variant="primary" size="sm" busy={create.isPending} disabled={name.trim() === ''}>
          新增
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          完成
        </Button>
      </div>
      <p className="text-xs text-graphite-300">手工新增的条目直接生效。编号（c1、l1、o1）由系统分配，拆镜时用它指代角色。</p>
    </form>
  );
}

/** Roster of characters / locations / props (FR-02): manual edits always work; AI extraction goes through a draft. */
export function EntitiesPanel({ entitiesQuery }: { entitiesQuery: UseQueryResult<Entity[]> }) {
  const ws = useWorkspace();
  const drafts = useDrafts();
  const extract = useExtractEntities();
  const confirmAll = useUpdateEntity();
  const tracked = useTrackedJob(ENTITIES_SLOT);
  const findDraft = useDraftFinder();
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const pending = (drafts.data ?? [])
    .filter((d) => d.kind === 'entities' && d.status === 'pending')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const unconfirmed = ws.entities.filter((e) => !e.confirmed).length;

  const onSucceeded = useCallback(
    async (job: Job) => {
      const id = await findDraft(job, 'entities', null);
      if (id) ws.openEntityDraft(id);
      else ws.notify('实体抽取已完成，但没有找到对应的草案。');
    },
    [findDraft, ws],
  );

  /** One PATCH per entity (the API has no bulk route); stops at the first failure. */
  const confirmEverything = async () => {
    setConfirmingAll(true);
    confirmAll.reset();
    try {
      for (const e of ws.entities.filter((x) => !x.confirmed)) {
        await confirmAll.mutateAsync({ id: e.id, input: { confirmed: true } });
      }
    } catch {
      // shown by confirmAll.error
    } finally {
      setConfirmingAll(false);
    }
  };

  const startExtract = () => {
    extract.mutate(undefined, { onSuccess: ({ job_id }) => trackJob(ENTITIES_SLOT, job_id) });
  };

  const extractTitle = ws.ai.reason ?? (tracked ? '抽取任务进行中' : `AI 抽取：把剧本全文发送到 ${ws.providerHost ?? '你配置的地址'}，结果先进草案`);

  return (
    <Panel
      title={collapsed && ws.entities.length > 0 ? `角色 · 地点 · 道具 ${ws.entities.length}` : '角色 · 地点 · 道具'}
      padded={false}
      // collapsed: only the header row; the scene list above takes the height
      className={collapsed ? 'grow-0 basis-auto' : ''}
      tools={
        <>
          <IconButton
            icon={collapsed ? ChevronRight : ChevronDown}
            label={collapsed ? '展开角色、地点和道具' : '折叠角色、地点和道具'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          />
          <IconButton
            icon={Sparkles}
            label="AI 抽取角色、地点和道具"
            title={extractTitle}
            onClick={startExtract}
            disabled={!ws.ai.enabled || tracked !== null || extract.isPending}
          />
          <IconButton
            icon={Plus}
            label="新增角色、地点或道具"
            onClick={() => {
              setCollapsed(false);
              setAdding(true);
            }}
          />
        </>
      }
    >
      {adding && !collapsed ? <AddEntityForm onDone={() => setAdding(false)} /> : null}
      {/* the job line stays mounted while collapsed: it opens the draft when extraction ends */}
      {tracked || extract.isError || pending ? (
        <div className="flex flex-col gap-2 border-b border-graphite-800 p-3">
          {extract.isError ? <ErrorNotice error={extract.error} context="ai-request" /> : null}
          <JobLine slot={ENTITIES_SLOT} onSucceeded={onSucceeded} onOpenDraft={ws.openEntityDraft} />
          {pending && !tracked ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-graphite-300">有一份实体草案待审。</span>
              <Button size="sm" onClick={() => ws.openEntityDraft(pending.id)}>
                查看草案
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {collapsed ? null : (
        entitiesQuery.isPending ? (
          <div className="p-3">
            <Spinner label="正在读取…" />
          </div>
        ) : entitiesQuery.isError ? (
          <div className="p-3">
            <ErrorNotice error={entitiesQuery.error} />
          </div>
        ) : ws.entities.length === 0 && !adding ? (
          <EmptyState
            quiet
            title="还没有角色、地点或道具。"
            description={
              ws.ai.enabled
                ? '可以用 AI 抽取生成草案，或点 + 手工添加。拆镜时，人物只能从角色名单里选。'
                : '点 + 手工添加。AI 抽取需要先在"设置 → 模型"里配置文本模型。拆镜时，人物只能从角色名单里选。'
            }
            action={
              ws.ai.enabled ? (
                <Button size="sm" onClick={startExtract} disabled={tracked !== null || extract.isPending} title={extractTitle}>
                  <Sparkles aria-hidden className="size-3" />
                  AI 抽取
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col py-1">
            {unconfirmed > 0 ? (
              <div className="flex flex-col gap-1.5 px-3 pt-1 pb-1.5">
                <div className="flex items-center gap-1.5 text-xs text-graphite-300">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
                  <span className="min-w-0 flex-1">{unconfirmed} 条 AI 抽取的条目待你确认</span>
                  <Button variant="ghost" size="sm" busy={confirmingAll} onClick={() => void confirmEverything()} title="核对过名单后，一次确认全部条目">
                    全部确认
                  </Button>
                </div>
                {confirmAll.isError ? <ErrorNotice error={confirmAll.error} /> : null}
              </div>
            ) : null}
            {TYPES.map((t) => {
              const list = ws.entities.filter((e) => e.type === t);
              if (list.length === 0) return null;
              return (
                <section key={t} aria-label={ENTITY_TYPE_LABEL[t]} className="py-1">
                  <h3 className="px-3 pb-0.5 text-xs text-graphite-300">
                    {ENTITY_TYPE_LABEL[t]} <span className="tabular-nums">{list.length}</span>
                  </h3>
                  <ul>
                    {list.map((e) => (
                      <EntityRow key={e.id} entity={e} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )
      )}
    </Panel>
  );
}
