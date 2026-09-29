import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GroupView } from '@storyscript/contracts';
import { FolderKanban, Settings2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { navigate } from '../lib/route.ts';
import { GroupDialog, meKey, useMe } from '../components/AccountMenu.tsx';
import { GroupForms } from '../components/AccountScreens.tsx';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Button, IconButton, Notice, Spinner, Tag } from '../components/ui.tsx';
import { PageHeader } from '../components/workspace.tsx';
import { FrameThumb } from './HomeView.tsx';

/**
 * Hosted server 项目 page (S2d): the groups one is in, as the same 2.39
 * frames the local project manager uses. Each group is one project; opening
 * another group switches this browser to it. While there is room (2 groups
 * by default, one's own included) the page offers to join or start one.
 */
export function HostedProjectsView({ onGroupChanged }: { onGroupChanged: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="正在读取小组…" />
      </div>
    );
  }
  if (me.isError || !me.data) {
    return (
      <div className="mx-auto max-w-[520px] px-4 py-10">
        <ErrorNotice error={me.error} context="account" />
      </div>
    );
  }

  const { groups, group: current, max_groups: max } = me.data;
  const room = groups.length < max;
  const settings = groups.find((g) => g.slug === settingsFor) ?? null;

  const open = async (g: GroupView) => {
    if (g.slug === current?.slug) {
      navigate('script');
      return;
    }
    setOpening(g.slug);
    setError(null);
    try {
      await api.call('switchGroup', undefined, { params: { slug: g.slug } });
      navigate('script');
      onGroupChanged();
    } catch (e) {
      setError(e);
      setOpening(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="项目"
        icon={FolderKanban}
        lead={`你所在的小组，每组一个项目。每人最多同时在 ${max} 个小组里（包括自己建的）。`}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-8 px-4 py-6">
          {error ? <ErrorNotice error={error} context="account" /> : null}
          <section aria-labelledby="my-groups">
            <h2 id="my-groups" className="mb-3 text-base font-medium text-graphite-100">
              我的小组 <span className="text-sm font-normal text-graphite-300 tabular-nums">{groups.length}/{max}</span>
            </h2>
            {groups.length === 0 ? (
              <p className="text-sm text-graphite-300">还没有小组。在下面建一个，或者用组长发的链接加入。</p>
            ) : (
              <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {groups.map((g) => {
                  const isCurrent = g.slug === current?.slug;
                  return (
                    <li key={g.slug} className="flex min-w-0 flex-col gap-2 rounded-panel p-1.5 hover:bg-graphite-900">
                      <button
                        type="button"
                        onClick={() => void open(g)}
                        disabled={opening !== null}
                        className="group flex w-full min-w-0 flex-col gap-2 text-left disabled:cursor-wait"
                        aria-label={isCurrent ? `打开「${g.name}」的项目（当前）` : `切换到「${g.name}」的项目`}
                      >
                        <FrameThumb kind="project" />
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-base font-medium text-graphite-100">{g.name}</span>
                          {isCurrent ? <Tag tone="ok">当前</Tag> : null}
                          {opening === g.slug ? <Spinner label="正在切换" /> : null}
                        </span>
                      </button>
                      <div className="flex items-center gap-2 px-0.5">
                        <span className="min-w-0 flex-1 truncate text-xs text-graphite-300">
                          {g.role === 'leader' ? '组长' : '组员'}，{g.members.length}/{g.max_members} 人
                        </span>
                        <IconButton icon={Settings2} label={`「${g.name}」的小组设置`} onClick={() => setSettingsFor(g.slug)} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="more-groups">
            <h2 id="more-groups" className="mb-3 text-base font-medium text-graphite-100">
              加入或新建小组
            </h2>
            {room ? (
              <GroupForms
                onDone={() => {
                  void qc.invalidateQueries({ queryKey: meKey });
                  navigate('script');
                  onGroupChanged();
                }}
              />
            ) : (
              <Notice tone="info" title={`你已经在 ${max} 个小组里了`}>
                每人最多同时在 {max} 个小组。要加入别的小组或者新建一个，先在某个小组的设置里退出它（组长只剩自己时可以解散）。
              </Notice>
            )}
          </section>
          {current ? (
            <div>
              <Button onClick={() => navigate('script')}>回到「{current.name}」</Button>
            </div>
          ) : null}
        </div>
      </div>
      {settings ? (
        <GroupDialog group={settings} current={settings.slug === current?.slug} onClose={() => setSettingsFor(null)} onGroupChanged={onGroupChanged} />
      ) : null}
    </div>
  );
}
