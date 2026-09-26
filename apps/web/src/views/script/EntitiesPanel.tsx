import { useCallback, useState, type FormEvent } from 'react';
import type { Entity, EntityType, Job } from '@storyscript/contracts';
import { Check, ChevronDown, ChevronRight, Pencil, Plus, Sparkles } from 'lucide-react';
import { ENTITIES_SLOT, trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { ENTITY_TYPE_LABEL } from '../../lib/labels.ts';
import { formatAliases, parseAliasInput } from '../../lib/drafts.ts';
import { useCreateEntity, useDrafts, useExtractEntities, useUpdateEntity } from '../../lib/queries.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Select, Tag, TextInput } from '../../components/ui.tsx';
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
    <form onSubmit={submit} className="flex flex-col gap-1.5 py-1.5">
      <div className="grid gap-1.5 sm:grid-cols-2">
        <TextInput aria-label="名称" value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-[13px]" autoFocus />
        <TextInput aria-label="别名，用顿号或逗号分隔" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="别名，用顿号分隔" className="h-7 text-[13px]" />
      </div>
      {update.isError ? <ErrorNotice error={update.error} /> : null}
      <div className="flex gap-1.5">
        <Button type="submit" variant="primary" className="h-7 px-2 text-xs" busy={update.isPending} disabled={name.trim() === ''}>
          保存
        </Button>
        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={onDone}>
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
      <li className="px-2">
        <EntityEditor entity={entity} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-2 px-2 py-1.5">
      <span className="mt-0.5 w-8 shrink-0 font-mono text-[11px] text-ink-3">{entity.alias}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] break-words text-ink">
          {entity.name}
          {entity.origin === 'ai' ? (
            <Tag tone="neutral" className="ml-1.5 align-[1px]">
              AI
            </Tag>
          ) : null}
        </p>
        {entity.aliases.length > 0 ? <p className="text-xs break-words text-ink-3">又称 {formatAliases(entity.aliases)}</p> : null}
        {update.isError ? <p className="text-xs text-danger">保存失败，请重试。</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {entity.confirmed ? (
          <button
            type="button"
            onClick={() => update.mutate({ id: entity.id, input: { confirmed: false } })}
            disabled={update.isPending}
            className="inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-xs text-ok hover:bg-sheet-sunk"
            title="已确认，点击取消确认"
          >
            <Check aria-hidden className="size-3.5" />
            已确认
          </button>
        ) : (
          <button
            type="button"
            onClick={() => update.mutate({ id: entity.id, input: { confirmed: true } })}
            disabled={update.isPending}
            className="inline-flex h-6 items-center rounded-control border border-warn-rule bg-warn-bg px-1.5 text-xs text-warn hover:border-warn"
            title="AI 抽取的条目需要你确认"
          >
            待确认
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex size-6 items-center justify-center rounded-control text-ink-3 hover:bg-sheet-sunk hover:text-ink"
          aria-label={`编辑 ${entity.name}`}
          title="改名 / 编辑别名"
        >
          <Pencil aria-hidden className="size-3.5" />
        </button>
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
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-sheet border border-rule bg-sheet-sunk/50 p-3">
      <div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]">
        <Select aria-label="类型" value={type} onChange={(e) => setType(e.target.value as EntityType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {ENTITY_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <TextInput aria-label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" autoFocus />
        <TextInput aria-label="别名" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="别名，用顿号分隔（可不填）" />
      </div>
      {create.isError ? <ErrorNotice error={create.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={create.isPending} disabled={name.trim() === ''}>
          {create.isPending ? null : <Plus aria-hidden className="size-3.5" />}
          新增
        </Button>
        <Button variant="ghost" onClick={onDone}>
          完成
        </Button>
      </div>
      <p className="text-xs text-ink-3">手工新增的条目直接生效。别名（c1、l1、o1）由系统分配，拆镜时用它指代角色。</p>
    </form>
  );
}

export interface EntitiesPanelProps {
  onOpenEntityDraft: (draftId: string) => void;
}

/** Roster of characters / locations / props (FR-02), collapsible. */
export function EntitiesPanel({ onOpenEntityDraft }: EntitiesPanelProps) {
  const ws = useWorkspace();
  const drafts = useDrafts();
  const extract = useExtractEntities();
  const tracked = useTrackedJob(ENTITIES_SLOT);
  const findDraft = useDraftFinder();
  const [open, setOpen] = useState(ws.entities.length === 0);
  const [adding, setAdding] = useState(false);

  const pending = (drafts.data ?? []).filter((d) => d.kind === 'entities' && d.status === 'pending').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const unconfirmed = ws.entities.filter((e) => !e.confirmed).length;

  const onSucceeded = useCallback(
    async (job: Job) => {
      const id = await findDraft(job, 'entities', null);
      if (id) onOpenEntityDraft(id);
      else ws.notify('实体抽取已完成，但没有找到对应的草案。');
    },
    [findDraft, onOpenEntityDraft, ws],
  );

  const startExtract = () => {
    extract.mutate(undefined, { onSuccess: ({ job_id }) => trackJob(ENTITIES_SLOT, job_id) });
  };

  const counts = TYPES.map((t) => `${ENTITY_TYPE_LABEL[t]} ${ws.entities.filter((e) => e.type === t).length}`).join(' · ');

  return (
    <section aria-labelledby="entities-title" className="rounded-sheet border border-rule bg-sheet">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="entities-body"
          className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-control px-1 py-0.5 text-left hover:bg-sheet-sunk"
        >
          {open ? <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-3" /> : <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3" />}
          <h2 id="entities-title" className="text-[14px] font-semibold text-ink">
            角色 · 地点 · 道具
          </h2>
          <span className="truncate text-xs text-ink-3">{counts}</span>
        </button>
        {unconfirmed > 0 ? <Tag tone="warn">{unconfirmed} 条待确认</Tag> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {pending ? (
            <Button className="h-7 px-2 text-xs" onClick={() => onOpenEntityDraft(pending.id)}>
              查看实体草案
            </Button>
          ) : null}
          <Button
            className="h-7 px-2 text-xs"
            onClick={startExtract}
            busy={extract.isPending}
            disabled={!ws.ai.enabled || tracked !== null}
            title={ws.ai.reason ?? `把剧本全文发送到 ${ws.providerHost ?? '你配置的地址'}，抽取角色、地点和道具，结果先进草案`}
          >
            {extract.isPending ? null : <Sparkles aria-hidden className="size-3.5" />}
            AI 抽取
          </Button>
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => {
              setOpen(true);
              setAdding(true);
            }}
          >
            <Plus aria-hidden className="size-3.5" />
            新增
          </Button>
        </div>
      </div>

      {tracked || extract.isError ? (
        <div className="flex flex-col gap-2 px-4 pb-3 sm:px-5">
          {extract.isError ? <ErrorNotice error={extract.error} context="ai-request" /> : null}
          <JobLine slot={ENTITIES_SLOT} onSucceeded={onSucceeded} />
        </div>
      ) : null}

      {open ? (
        <div id="entities-body" className="border-t border-rule px-4 py-3 sm:px-5">
          {adding ? (
            <div className="mb-3">
              <AddEntityForm onDone={() => setAdding(false)} />
            </div>
          ) : null}
          {ws.entities.length === 0 && !adding ? (
            <p className="text-[13px] text-ink-3">
              还没有角色、地点或道具。{ws.ai.enabled ? '可以用"AI 抽取"生成草案，或' : ''}点"新增"手工添加。拆镜时，人物只能从角色名单里选。
            </p>
          ) : null}
          {ws.entities.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {TYPES.map((t) => {
                const list = ws.entities.filter((e) => e.type === t);
                return (
                  <div key={t} className="min-w-0">
                    <h3 className="mb-1 text-xs font-medium text-ink-2">
                      {ENTITY_TYPE_LABEL[t]} <span className="text-ink-3 tabular-nums">{list.length}</span>
                    </h3>
                    {list.length === 0 ? (
                      <p className="px-2 text-xs text-ink-3">无</p>
                    ) : (
                      <ul className="divide-y divide-rule rounded-sheet border border-rule">
                        {list.map((e) => (
                          <EntityRow key={e.id} entity={e} />
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
