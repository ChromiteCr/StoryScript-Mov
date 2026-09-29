import { useState, type ReactNode } from 'react';
import type { CastSyncPreview } from '@storyscript/contracts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Tag } from '../../components/ui.tsx';
import { isApiClientError } from '../../lib/api.ts';
import { appliedChanges, buildCastSyncInput, defaultSyncWindow, groupCastSync, newResourceNames } from '../../lib/cast.ts';
import { useApplyCastSync } from '../../lib/queries-cast.ts';
import { CheckRow, TimeField } from './controls.tsx';
import { fromLocalWindow, type LocalWindow, type PlanData } from './data.ts';

/**
 * 同步演员和场地: what the plan's performers and locations still need to
 * match the script (each character's actor, each scene location). The
 * preview comes from the server with a hash; applying sends the hash back, so
 * a script or plan that moved in between is refused (409) and refetched.
 * People and places the sync creates get the availability set here.
 */

const GROUP_TITLE = 'text-sm font-semibold text-graphite-100';

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className={GROUP_TITLE}>
        {title} <span className="text-xs font-normal text-graphite-300 tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  );
}

export function CastSyncDialog({
  data,
  refDate,
  preview,
  onClose,
  onSynced,
}: {
  data: PlanData;
  /** the plan's date (or today): the day the new people and places are available on */
  refDate: string;
  preview: CastSyncPreview;
  onClose: () => void;
  /** how many resources the sync changed */
  onSynced: (changed: number) => void;
}) {
  const tz = data.project.timezone;
  const apply = useApplyCastSync();
  const [includeLocations, setIncludeLocations] = useState(true);
  const [avail, setAvail] = useState<LocalWindow>(() => defaultSyncWindow(refDate));
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const locationIds = new Set(data.entities.filter((e) => e.type === 'location').map((e) => e.id));
  const groups = groupCastSync(preview.changes, locationIds);
  const hasPlaces = groups.places.length > 0;
  const applied = appliedChanges(preview.changes, locationIds, includeLocations);
  const created = newResourceNames(applied);
  const overnight = avail.start && avail.end && avail.end <= avail.start;

  const submit = () => {
    const utc = fromLocalWindow(avail, tz);
    if (!utc) return setProblem('请把日期和起止时间填完整');
    setProblem(null);
    setStale(false);
    apply.mutate(buildCastSyncInput({ hash: preview.hash, includeLocations, window: utc, confirmed }), {
      onSuccess: (changed) => {
        onSynced(changed.length);
        onClose();
      },
      onError: (e) => {
        if (isApiClientError(e) && e.status === 409) setStale(true);
      },
    });
  };

  return (
    <Dialog
      onClose={onClose}
      busy={apply.isPending}
      title="同步演员和场地"
      description="按剧本里角色的「演员」和场次的地点，补全计划里的演员和场地。已有的演员、场地只补上角色或地点，不会删除。"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={apply.isPending}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} busy={apply.isPending} disabled={applied.length === 0}>
            同步到计划
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {stale ? (
          <Notice tone="warn" role="status" title="剧本或计划刚改过，已刷新，请再看一遍" />
        ) : null}
        {preview.changes.length === 0 ? <Notice tone="info" title="剧本和计划已经一致，没有要同步的。" /> : null}

        {groups.newPerformers.length > 0 ? (
          <Group title="新演员" count={groups.newPerformers.length}>
            <ul className="flex flex-col gap-1 text-sm text-graphite-100">
              {groups.newPerformers.map((p) => (
                <li key={p.name} className="break-words">
                  {p.name}：饰 {p.characters.join('、')}
                </li>
              ))}
            </ul>
          </Group>
        ) : null}

        {groups.addedRoles.length > 0 ? (
          <Group title="补上角色" count={groups.addedRoles.length}>
            <ul className="flex flex-col gap-1 text-sm text-graphite-100">
              {groups.addedRoles.map((p) => (
                <li key={p.name} className="break-words">
                  {p.name}：加饰 {p.characters.join('、')}
                </li>
              ))}
            </ul>
          </Group>
        ) : null}

        {groups.moved.length > 0 ? (
          <Group title="换演员" count={groups.moved.length}>
            <ul className="flex flex-col gap-1 text-sm text-graphite-100">
              {groups.moved.map((m) => (
                <li key={`${m.character}-${m.from}-${m.to}`} className="break-words">
                  {m.character}：{m.from} → {m.to}
                </li>
              ))}
            </ul>
          </Group>
        ) : null}

        {hasPlaces ? (
          <Group title="场地" count={groups.places.length}>
            <ul className={`flex flex-col gap-1 text-sm ${includeLocations ? 'text-graphite-100' : 'text-graphite-300'}`}>
              {groups.places.map((p) => (
                <li key={`${p.resource}-${p.location}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 break-words">
                  {p.isNew ? (
                    <>
                      新场地「{p.location}」<Tag>新建</Tag>
                    </>
                  ) : (
                    <>
                      场地「{p.resource}」对应地点「{p.location}」
                    </>
                  )}
                </li>
              ))}
            </ul>
            <CheckRow checked={includeLocations} onChange={setIncludeLocations}>
              同时同步场地
            </CheckRow>
          </Group>
        ) : null}

        {created.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold text-graphite-100">新建的 {created.length} 个演员、场地何时能到场</legend>
            <p className="text-xs text-graphite-300">按项目时区 {tz} 填写。结束不晚于开始时，按跨午夜到次日处理。以后可以在资源里逐个改。</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="date"
                aria-label="可用日期"
                value={avail.date}
                onChange={(e) => setAvail({ ...avail, date: e.target.value })}
                className="h-7 w-full rounded-control border border-graphite-700 bg-graphite-800 px-1.5 text-sm text-graphite-100 tabular-nums hover:border-graphite-500 sm:w-auto"
              />
              <TimeField label="可用开始" value={avail.start} onChange={(v) => setAvail({ ...avail, start: v })} />
              <span aria-hidden className="text-graphite-300">
                –
              </span>
              <TimeField label="可用结束" value={avail.end} onChange={(v) => setAvail({ ...avail, end: v })} />
              {overnight ? <Tag>次日</Tag> : null}
            </div>
            <CheckRow checked={confirmed} onChange={setConfirmed} hint="不勾的话，新建的演员和场地标为待确认，批准计划前要逐个确认。">
              这些人和地点这段时间都能到场（已确认）
            </CheckRow>
          </fieldset>
        ) : null}

        {problem ? <Notice tone="danger" title={problem} /> : null}
        {apply.isError && !stale ? <ErrorNotice error={apply.error} /> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
