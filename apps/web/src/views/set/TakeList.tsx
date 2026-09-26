import { useId, useState, type FormEvent } from 'react';
import type { Take, TakeRating } from '@storyscript/contracts';
import { Pencil } from 'lucide-react';
import { Button, IconButton, TextInput } from '../../components/ui.tsx';
import { EmptyState } from '../../components/workspace.tsx';
import { isApiClientError } from '../../lib/api.ts';
import { useUpdateTake } from '../../lib/queries-media.ts';
import { MediaErrorNotice, RatingBadge } from '../media/shared.tsx';
import { clockTime, type ShotRef } from './model.ts';
import { RatingPicker } from './RatingPicker.tsx';

/**
 * Right column of the set page: takes of the current shot, newest first.
 * Logged facts are corrected, not overwritten silently: every change needs a
 * reason and the take's current revision (409 when someone else changed it).
 */

export function TakeList({ takes, refsById, currentId }: { takes: Take[]; refsById: ReadonlyMap<string, ShotRef>; currentId: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (takes.length === 0) {
    return <EmptyState title="这个镜头还没有条次。" description="在中间填好后按 Enter 保存，第一条就会出现在这里。" />;
  }
  return (
    <ul className="divide-y divide-graphite-800">
      {takes.map((t) =>
        editing === t.id ? (
          <li key={t.id} className="p-3">
            <TakeEditor take={t} onDone={() => setEditing(null)} />
          </li>
        ) : (
          <li key={t.id} className="flex gap-3 px-3 py-2.5">
            <span className="w-10 shrink-0 text-lg leading-6 font-medium text-graphite-100 tabular-nums">T{String(t.take_no).padStart(2, '0')}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <RatingBadge rating={t.rating} />
                {t.camera_label ? <span className="text-xs text-graphite-300">机位 {t.camera_label}</span> : null}
                <span className="text-xs text-graphite-300 tabular-nums">{clockTime(t.logged_at)}</span>
                {t.revision > 0 ? <span className="text-xs text-graphite-300">已更正 {t.revision} 次</span> : null}
              </div>
              {t.clip_hint ? <p className="truncate font-mono text-xs text-graphite-100">{t.clip_hint}</p> : null}
              {t.notes ? <p className="text-sm break-words text-graphite-100">{t.notes}</p> : null}
              {t.shot_ids.length > 1 ? (
                <p className="text-xs text-graphite-300">
                  同条：
                  {t.shot_ids
                    .filter((id) => id !== currentId)
                    .map((id) => refsById.get(id)?.label ?? '（已归档镜头）')
                    .join('、')}
                </p>
              ) : null}
              {t.unresolved_labels.length > 0 ? <p className="text-xs text-graphite-300">手写镜号：{t.unresolved_labels.join('、')}</p> : null}
            </div>
            <IconButton icon={Pencil} label={`更正 T${t.take_no}`} onClick={() => setEditing(t.id)} />
          </li>
        ),
      )}
    </ul>
  );
}

function TakeEditor({ take, onDone }: { take: Take; onDone: () => void }) {
  const update = useUpdateTake();
  const ids = useId();
  const [takeNo, setTakeNo] = useState(String(take.take_no));
  const [camera, setCamera] = useState(take.camera_label ?? '');
  const [rating, setRating] = useState<TakeRating>(take.rating);
  const [clip, setClip] = useState(take.clip_hint ?? '');
  const [notes, setNotes] = useState(take.notes);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d+$/.test(takeNo.trim()) || Number(takeNo) < 1) return setError('条次号需要是正整数');
    if (reason.trim() === '') return setError('请写明更正原因，原记录会保留在修订记录里');
    setError(null);
    update.mutate(
      {
        id: take.id,
        input: {
          expected_revision: take.revision,
          take_no: Number(takeNo),
          camera_label: camera.trim() || null,
          rating,
          clip_hint: clip.trim() || null,
          notes: notes.trim(),
          reason: reason.trim(),
        },
      },
      { onSuccess: onDone },
    );
  };

  const conflict = update.isError && isApiClientError(update.error) && update.error.code === 'REVISION_CONFLICT';

  return (
    <form onSubmit={submit} noValidate aria-label={`更正 T${take.take_no}`} className="flex flex-col gap-2.5">
      <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-graphite-100">
          条次号
          <TextInput value={takeNo} onChange={(e) => setTakeNo(e.target.value)} inputMode="numeric" className="tabular-nums" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-graphite-100">
          机位
          <TextInput value={camera} onChange={(e) => setCamera(e.target.value)} />
        </label>
      </div>
      <RatingPicker value={rating} onChange={setRating} size="sm" label="更正评级" />
      <label className="flex flex-col gap-1 text-xs font-medium text-graphite-100">
        机内文件名
        <TextInput value={clip} onChange={(e) => setClip(e.target.value)} className="font-mono" spellCheck={false} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-graphite-100">
        备注
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-reason`} className="text-xs font-medium text-graphite-100">
          更正原因（必填）
        </label>
        <TextInput id={`${ids}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：回看发现跑焦" aria-invalid={error !== null && reason.trim() === ''} />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-graphite-100">
          {error}
        </p>
      ) : null}
      {update.isError ? <MediaErrorNotice error={update.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" busy={update.isPending} disabled={conflict}>
          保存更正
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {conflict ? '关闭' : '取消'}
        </Button>
      </div>
    </form>
  );
}
