import { useId, useMemo, useState, type FormEvent } from 'react';
import type { MediaAssetView, ShotMediaLink, Take } from '@storyscript/contracts';
import { CircleAlert, Wand2 } from 'lucide-react';
import { Button, Field, TextInput } from '../../components/ui.tsx';
import { EmptyState } from '../../components/workspace.tsx';
import { CANDIDATE_ERROR_LABEL, EVIDENCE_LABEL } from '../../lib/labels-media.ts';
import { useBuildCandidates } from '../../lib/queries-media.ts';
import type { ShotRef } from '../set/model.ts';
import { Drawer } from './Drawer.tsx';
import { LinkActions } from './LinkActions.tsx';
import { candidateGroups, conflictedAssets, fileName, isRangeExact } from './model.ts';
import { MediaErrorNotice } from './shared.tsx';

/**
 * 候选审核: run the file-name rules (R1 slate code, R2 clip name from the set
 * log, R3 the user's pattern), then confirm or reject each candidate. Nothing
 * is ever confirmed automatically; conflicts are marked in red with the
 * competing shots named.
 */

export function CandidateReview({
  onClose,
  refs,
  takes,
  links,
  assets,
}: {
  onClose: () => void;
  refs: readonly ShotRef[];
  takes: readonly Take[];
  links: readonly ShotMediaLink[];
  assets: ReadonlyMap<string, MediaAssetView>;
}) {
  const build = useBuildCandidates();
  const id = useId();
  const [pattern, setPattern] = useState('');

  const groups = useMemo(() => candidateGroups(links, refs), [links, refs]);
  const conflicts = useMemo(() => conflictedAssets(links, takes), [links, takes]);
  const refById = useMemo(() => new Map(refs.map((r) => [r.shot.id, r] as const)), [refs]);
  const claimants = (assetId: string, shotId: string) =>
    [...new Set(links.filter((l) => l.media_asset_id === assetId && l.status !== 'rejected' && l.shot_id !== shotId).map((l) => refById.get(l.shot_id)?.label ?? '？'))];

  const run = (e: FormEvent) => {
    e.preventDefault();
    build.mutate({ user_regex: pattern.trim() || null });
  };

  const total = groups.reduce((n, g) => n + g.links.length, 0);

  return (
    <Drawer title={`候选审核${total > 0 ? `（${total}）` : ''}`} onClose={onClose} wide>
      <form onSubmit={run} className="flex flex-col gap-2.5 border-b border-graphite-800 p-4" aria-label="生成候选">
        <p className="text-sm text-graphite-300">
          按文件名找素材与镜头的对应：打板编号、场记里的机内文件名，或你的自定义规则。候选只是建议，每条都由你确认。
        </p>
        <Field
          label="自定义规则（可选）"
          hint={
            <>
              正则表达式，命名组 <code className="font-mono">(?&lt;scene&gt;…)</code> <code className="font-mono">(?&lt;shot&gt;…)</code>{' '}
              <code className="font-mono">(?&lt;take&gt;…)</code>，其中 shot 必填。例：<code className="font-mono">SC(?&lt;scene&gt;\d+)_SH(?&lt;shot&gt;\d+)</code>
            </>
          }
        >
          {(ids) => (
            <TextInput
              id={ids.id}
              aria-describedby={ids.describedBy}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              placeholder="留空只用内置规则"
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" size="sm" busy={build.isPending}>
            <Wand2 aria-hidden className="size-3.5" />
            生成候选
          </Button>
          <p role="status" aria-live="polite" className="text-sm text-graphite-300 tabular-nums">
            {build.data ? `新增 ${build.data.created.length} 条候选，规则共找到 ${build.data.candidates.length} 处对应` : null}
          </p>
        </div>
        {build.data && build.data.errors.length > 0 ? (
          <ul className="flex flex-col gap-1" aria-label="规则问题">
            {build.data.errors.map((e, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-graphite-100">
                <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-warn" />
                <span>
                  {CANDIDATE_ERROR_LABEL[e.code] ?? e.code}
                  <span className="block text-graphite-300">{e.message}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {build.isError ? <MediaErrorNotice error={build.error} /> : null}
      </form>

      {groups.length === 0 ? (
        <EmptyState title="没有待审核的候选。" description={build.data ? '规则没有找到新的对应。可以试试自定义规则，或在检查器里手动关联。' : '点"生成候选"按文件名查找。'} />
      ) : (
        <div className="flex flex-col" id={`${id}-list`}>
          {groups.map((g) => (
            <section key={g.shotId} aria-label={g.ref?.label ?? '镜头'} className="border-b border-graphite-800">
              <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-graphite-900 px-4 pt-3 pb-1.5">
                <h3 className="text-sm font-medium text-graphite-100 tabular-nums">{g.ref?.label ?? '（已归档镜头）'}</h3>
                <p className="min-w-0 truncate text-xs text-graphite-300">{g.ref?.shot.fields.action}</p>
              </div>
              <ul className="flex flex-col">
                {g.links.map((l) => {
                  const a = assets.get(l.media_asset_id);
                  const take = takes.find((t) => t.id === l.take_id);
                  const conflict = conflicts.has(l.media_asset_id);
                  const others = conflict ? claimants(l.media_asset_id, l.shot_id) : [];
                  return (
                    <li key={l.id} className={`flex gap-3 px-4 py-2.5 ${conflict ? 'border-l-2 border-l-danger' : ''}`}>
                      <span className="flex aspect-video w-20 shrink-0 items-center justify-center overflow-hidden rounded-control bg-graphite-950">
                        {a?.poster_url ? <img src={a.poster_url} alt="" loading="lazy" className="h-full w-full object-contain" /> : null}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <p className="truncate text-sm text-graphite-100" title={a?.rel_path}>
                          {a ? fileName(a.rel_path) : '（素材已不存在）'}
                        </p>
                        <p className="text-xs text-graphite-300">
                          {EVIDENCE_LABEL[l.evidence]}
                          {take ? ` · T${String(take.take_no).padStart(2, '0')}` : ' · 未指定条次'}
                        </p>
                        {a && !isRangeExact(l, a) ? (
                          <p className="text-xs text-graphite-300">片段区间是估算的（素材缺少精确的起止信息），不能用于"设为可用"。</p>
                        ) : null}
                        {conflict ? (
                          <p className="flex items-start gap-1 text-xs text-graphite-100">
                            <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-danger" />
                            <span>
                              冲突：这条素材同时被 {others.join('、') || '其他镜头'} 认领，而且不是同一条场记覆盖的镜头。确认前请回看画面。
                            </span>
                          </p>
                        ) : null}
                        <LinkActions link={l} compact />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Drawer>
  );
}
