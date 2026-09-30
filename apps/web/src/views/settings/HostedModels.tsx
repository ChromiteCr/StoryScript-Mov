import { useId, type ReactNode } from 'react';
import type { GroupView, ModelSource } from '@storyscript/contracts';
import { useMe, useSetModelChoice } from '../../components/AccountMenu.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Notice, Spinner } from '../../components/ui.tsx';
import { Inspector } from '../../components/workspace.tsx';
import { CHOICE_HINT, GROUP_READ_ONLY, MODEL_KIND_LABEL, MODEL_SOURCE_LABEL, OWN_KEY_NOTE, ownChoiceWarning, type ModelKind } from '../../lib/models.ts';
import { useScopedProviders } from '../../lib/queries.ts';
import { TextProviderPanel } from '../TextProviderPanel.tsx';
import { ImageProviderPanel } from './ImageProviderPanel.tsx';

/**
 * Settings → 模型 on the hosted server (S4): the group's model (the leader
 * edits it, a member sees it read-only), the member's own model (private to
 * them), and which of the two their requests use in this group, chosen
 * separately for text and for image. The local app keeps its single form.
 */

/** A titled band of the models page: the heading and what it means, then its panels. */
function ModelSection({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-graphite-800 pb-2">
      <div className="px-3 pt-5 pb-1">
        <h3 id={id} className="text-base font-semibold text-graphite-100">
          {title}
        </h3>
        <p className="mt-1 text-xs leading-5 text-graphite-300">{lead}</p>
      </div>
      <Inspector>{children}</Inspector>
    </section>
  );
}

const SOURCES: readonly ModelSource[] = ['group', 'own'];

/** 组的模型 | 我的模型 for one kind: two toggle buttons, the chosen one's hint, and a warning when 我的模型 is chosen but empty. */
function ChoiceRow({ group, kind }: { group: GroupView; kind: ModelKind }) {
  const labelId = useId();
  const set = useSetModelChoice();
  const mine = useScopedProviders('me');
  const value = group.model_choice[kind];
  // the choice being saved shows at once; the row settles when the refetch lands
  const shown = set.isPending && set.variables ? (set.variables.choice[kind] ?? value) : value;
  const warning = mine.data ? ownChoiceWarning(kind, shown, mine.data) : null;

  return (
    <div className="grid grid-cols-[minmax(84px,112px)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
      <span id={labelId} className="text-xs leading-6 text-graphite-300">
        {MODEL_KIND_LABEL[kind]}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex gap-1">
        {SOURCES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={shown === s}
            disabled={set.isPending}
            onClick={() => {
              if (s !== shown) set.mutate({ slug: group.slug, choice: { [kind]: s } });
            }}
            className={
              'h-7 min-w-0 flex-1 rounded-control border px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 ' +
              (shown === s ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950' : 'border-graphite-700 text-graphite-300 hover:enabled:text-graphite-100')
            }
          >
            {MODEL_SOURCE_LABEL[s]}
          </button>
        ))}
      </div>
      <p className="col-start-2 text-xs text-graphite-300">{CHOICE_HINT[shown]}</p>
      {warning ? (
        <Notice tone="warn" title={`还没填好你自己的${MODEL_KIND_LABEL[kind]}`} role="status" className="col-start-2">
          {warning}
        </Notice>
      ) : null}
      {set.isError ? <ErrorNotice error={set.error} context="account" className="col-start-2" /> : null}
    </div>
  );
}

function UseInGroup({ group }: { group: GroupView }) {
  return (
    <div className="flex flex-col gap-4 px-3 py-3">
      <ChoiceRow group={group} kind="text" />
      <ChoiceRow group={group} kind="image" />
    </div>
  );
}

export function HostedModels() {
  const me = useMe();
  const groupSettings = useScopedProviders('group');
  const group = me.data?.group ?? null;
  const leader = group?.role === 'leader';
  const readOnly = groupSettings.data?.editable === false;

  return (
    <>
      <div className="px-3 pt-3">
        <Notice tone="info" title="每个小组用自己的模型服务">
          组长填写本组的 base_url、模型名和 key，选了「组的模型」的人共用；每个人也可以在「我的模型」里填自己的，并选择在本组用哪一个。服务器只保存它们并转发请求，只能连接公网上的 https 地址。没有配置文本模型时，拆镜和实体抽取可以手工完成。
        </Notice>
      </div>

      <ModelSection title="在本组使用" lead="你在这个小组发起的 AI 请求用哪一套模型，文本和图像分别选。这个选择只对你自己、只在这个小组生效。">
        {me.isPending ? (
          <div className="px-3 py-3">
            <Spinner label="正在读取…" />
          </div>
        ) : me.isError || !group ? (
          <div className="px-3 py-3">
            <ErrorNotice error={me.error} context="account" />
          </div>
        ) : (
          <UseInGroup group={group} />
        )}
      </ModelSection>

      <ModelSection
        title="本组的模型"
        lead={leader ? '由你（组长）管理，组里选了「组的模型」的人共用。key 只有你看得到。' : '由组长管理，选了「组的模型」的人共用。'}
      >
        {readOnly ? (
          <div className="px-3 py-3">
            <Notice tone="info" title={GROUP_READ_ONLY.title}>
              {GROUP_READ_ONLY.body}
            </Notice>
          </div>
        ) : null}
        <TextProviderPanel scope="group" />
        <ImageProviderPanel scope="group" />
      </ModelSection>

      <ModelSection title="我的模型" lead={OWN_KEY_NOTE}>
        <TextProviderPanel scope="me" />
        <ImageProviderPanel scope="me" />
      </ModelSection>
    </>
  );
}
