import { useId, useState, type FormEvent } from 'react';
import type { MediaAssetView, ShotMediaLink, Take } from '@storyscript/contracts';
import { Link2 } from 'lucide-react';
import { Button, SelectInput } from '../../components/ui.tsx';
import { EmptyState, Inspector, InspectorGroup, InspectorRow } from '../../components/workspace.tsx';
import {
  AVAILABILITY_LABEL,
  EVIDENCE_LABEL,
  HASH_STATUS_LABEL,
  KIND_LABEL,
  LINK_STATUS_LABEL,
  NEEDS_PROXY_LABEL,
} from '../../lib/labels-media.ts';
import { useCreateLink } from '../../lib/queries-media.ts';
import type { ShotRef } from '../set/model.ts';
import { clipSummary, fileName, formatBytes, formatClipDuration, isRangeExact, videoStream } from './model.ts';
import { LinkActions } from './LinkActions.tsx';
import { MediaErrorNotice, MiniTag } from './shared.tsx';

/** Right column: facts of the selected clip, playback when direct-play, and its links to shots. */

export function AssetInspector({
  asset,
  refs,
  takes,
  links,
}: {
  asset: MediaAssetView | null;
  refs: readonly ShotRef[];
  takes: readonly Take[];
  links: readonly ShotMediaLink[];
}) {
  if (!asset) return <EmptyState title="在素材库里选一条素材。" description="这里显示它的编码、时间码、校验状态，以及关联到的镜头。" />;
  const s = clipSummary(asset);
  const v = videoStream(asset);
  const mine = links.filter((l) => l.media_asset_id === asset.id);
  const refById = new Map(refs.map((r) => [r.shot.id, r] as const));

  return (
    <Inspector>
      <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
        {asset.stream_url && asset.availability === 'online' ? (
          <video
            key={asset.id}
            src={asset.stream_url}
            poster={asset.poster_url ?? undefined}
            controls
            preload="metadata"
            className="aspect-video w-full rounded-control bg-graphite-950"
          />
        ) : asset.poster_url ? (
          <img src={asset.poster_url} alt={`${fileName(asset.rel_path)} 海报帧`} className="aspect-video w-full rounded-control bg-graphite-950 object-contain" />
        ) : null}
        <p className="text-sm font-medium break-all text-graphite-100">{fileName(asset.rel_path)}</p>
        <p className="text-xs break-all text-graphite-300">
          {asset.root_label} / <span className="font-mono">{asset.rel_path}</span>
        </p>
        <div className="flex flex-wrap gap-1">
          {asset.kind === 'video' && !asset.playable_direct ? <MiniTag title="浏览器不能直接播放这种编码">{NEEDS_PROXY_LABEL}</MiniTag> : null}
          {asset.availability === 'offline' ? <MiniTag tone="danger">离线</MiniTag> : null}
          {asset.is_vfr_suspect ? <MiniTag tone="warn">疑似可变帧率</MiniTag> : null}
        </div>
      </div>

      <InspectorGroup title="素材信息">
        <InspectorRow label="类型">{KIND_LABEL[asset.kind]}</InspectorRow>
        <InspectorRow label="编码">{s.codec || '—'}</InspectorRow>
        <InspectorRow label="分辨率">{s.resolution ? <span className="tabular-nums">{s.resolution}</span> : '—'}</InspectorRow>
        <InspectorRow label="帧率">{s.fps ? <span className="tabular-nums">{s.fps} fps</span> : '—'}</InspectorRow>
        <InspectorRow label="时长">{asset.probe?.duration_s ? <span className="tabular-nums">{formatClipDuration(asset.probe.duration_s)}</span> : '—'}</InspectorRow>
        <InspectorRow label="时间码">{asset.probe?.timecode ? <span className="font-mono">{asset.probe.timecode}</span> : '无'}</InspectorRow>
        {v?.pix_fmt ? <InspectorRow label="像素格式">{v.pix_fmt}</InspectorRow> : null}
        <InspectorRow label="大小">
          <span className="tabular-nums">{formatBytes(asset.size)}</span>
        </InspectorRow>
        <InspectorRow label="校验">
          {HASH_STATUS_LABEL[asset.hash_status]}
          {asset.sha256 ? (
            <span className="block truncate font-mono text-xs text-graphite-300" title={asset.sha256}>
              SHA-256 {asset.sha256.slice(0, 16)}…
            </span>
          ) : null}
        </InspectorRow>
        <InspectorRow label="状态">{AVAILABILITY_LABEL[asset.availability]}</InspectorRow>
      </InspectorGroup>

      <InspectorGroup
        title={`关联的镜头（${mine.filter((l) => l.status !== 'rejected').length}）`}
        note={
          mine.length === 0 ? (
            <p className="text-graphite-300">还没有关联。可以在下面手动关联，或用"候选审核"按文件名批量找。</p>
          ) : (
            <ul className="flex flex-col divide-y divide-graphite-800">
              {mine.map((l) => {
                const ref = refById.get(l.shot_id);
                const take = takes.find((t) => t.id === l.take_id);
                return (
                  <li key={l.id} className="flex flex-col gap-1 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-graphite-100 tabular-nums">
                        {ref?.label ?? '（已归档镜头）'}
                        {take ? ` · T${String(take.take_no).padStart(2, '0')}` : ''}
                      </span>
                      <span className="shrink-0 text-xs text-graphite-300">{LINK_STATUS_LABEL[l.status]}</span>
                    </div>
                    <span className="text-xs text-graphite-300">
                      {EVIDENCE_LABEL[l.evidence]}
                      {isRangeExact(l, asset) ? '' : '，片段区间不精确'}
                    </span>
                    <LinkActions link={l} />
                  </li>
                );
              })}
            </ul>
          )
        }
      />

      <InspectorGroup title="关联到镜头" note={<LinkForm asset={asset} refs={refs} takes={takes} />} />
    </Inspector>
  );
}

function LinkForm({ asset, refs, takes }: { asset: MediaAssetView; refs: readonly ShotRef[]; takes: readonly Take[] }) {
  const create = useCreateLink();
  const id = useId();
  const [shotId, setShotId] = useState('');
  const [takeId, setTakeId] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const shotTakes = takes.filter((t) => t.shot_ids.includes(shotId)).sort((a, b) => a.take_no - b.take_no);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!shotId) return;
    setDone(null);
    create.mutate(
      { shot_id: shotId, media_asset_id: asset.id, take_id: takeId || null },
      { onSuccess: (l) => setDone(l.status === 'candidate' ? '已加入候选，确认后才算关联。' : `已存在：${LINK_STATUS_LABEL[l.status]}`) },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-label="关联到镜头">
      <SelectInput
        id={`${id}-shot`}
        aria-label="镜头"
        value={shotId}
        onChange={(e) => {
          setShotId(e.target.value);
          setTakeId('');
        }}
      >
        <option value="">选择镜头…</option>
        {refs.map((r) => (
          <option key={r.shot.id} value={r.shot.id}>
            {r.label} {r.shot.fields.action.slice(0, 18)}
          </option>
        ))}
      </SelectInput>
      <SelectInput id={`${id}-take`} aria-label="条次" value={takeId} onChange={(e) => setTakeId(e.target.value)} disabled={!shotId || shotTakes.length === 0}>
        <option value="">{shotId && shotTakes.length === 0 ? '这个镜头还没有条次' : '不指定条次'}</option>
        {shotTakes.map((t) => (
          <option key={t.id} value={t.id}>
            T{String(t.take_no).padStart(2, '0')}
            {t.clip_hint ? ` · ${t.clip_hint}` : ''}
          </option>
        ))}
      </SelectInput>
      <Button type="submit" size="sm" disabled={!shotId} busy={create.isPending}>
        <Link2 aria-hidden className="size-3.5" />
        关联（作为候选）
      </Button>
      <p role="status" className="text-xs text-graphite-300">
        {done}
      </p>
      {create.isError ? <MediaErrorNotice error={create.error} /> : null}
    </form>
  );
}
