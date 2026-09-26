import type { Shot } from '@storyscript/contracts';
import { ORIGIN_LABEL, shotSpecLine } from '../../lib/labels.ts';
import { useShotRevisions } from '../../lib/queries.ts';
import { changedFieldLabels, revisionLabel } from '../../lib/shots.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Spinner, Tag } from '../../components/ui.tsx';

/** Revision history of one shot (FR-03: every edit writes a shot_revision). */
export function RevisionsDialog({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const revisions = useShotRevisions(shot.id);
  const list = [...(revisions.data ?? [])].sort((a, b) => b.revision - a.revision);
  const byRevision = new Map((revisions.data ?? []).map((r) => [r.revision, r] as const));

  return (
    <Dialog onClose={onClose} variant="drawer" title={`修订历史 · ${shot.code}`} description="每次保存、锁定、改编号和改必拍状态都会留下一条修订，最新的在最上面。">
      {revisions.isPending ? <Spinner label="正在读取…" /> : null}
      {revisions.isError ? <ErrorNotice error={revisions.error} /> : null}
      {revisions.data && list.length === 0 ? <p className="text-sm text-graphite-300">还没有修订记录。</p> : null}
      <ol className="flex flex-col gap-2">
        {list.map((r) => {
          const prev = [...byRevision.keys()].filter((k) => k < r.revision).sort((a, b) => b - a)[0];
          const changed = changedFieldLabels(prev === undefined ? null : (byRevision.get(prev)?.fields ?? null), r.fields);
          return (
            <li key={r.id} className="rounded-panel border border-graphite-800 bg-graphite-950/40 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-graphite-100 tabular-nums">{revisionLabel(r.revision)}</span>
                <Tag>{ORIGIN_LABEL[r.origin]}</Tag>
                {r.revision === shot.revision ? <Tag>当前</Tag> : null}
                <time dateTime={r.at} className="ml-auto text-xs text-graphite-300 tabular-nums">
                  {new Date(r.at).toLocaleString('zh-CN')}
                </time>
              </div>
              <p className="mt-1 text-sm text-graphite-100">{shotSpecLine(r.fields)}</p>
              {r.fields.action ? <p className="text-sm break-words text-graphite-300">{r.fields.action}</p> : null}
              {changed.length > 0 ? <p className="mt-1 text-xs text-graphite-300">改动：{changed.join('、')}</p> : null}
              {r.reason ? <p className="mt-1 text-xs break-words text-graphite-100">说明：{r.reason}</p> : null}
            </li>
          );
        })}
      </ol>
    </Dialog>
  );
}
