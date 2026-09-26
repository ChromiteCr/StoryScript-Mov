import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Take, TakeRating } from '@storyscript/contracts';
import { ZH_CAMERA_ANGLE, ZH_MOVEMENT, ZH_SHOT_SIZE } from '@storyscript/core';
import { CornerDownLeft, X } from 'lucide-react';
import { Button, TextInput } from '../../components/ui.tsx';
import { ratingForKey, REQUIRED_LABEL } from '../../lib/labels-media.ts';
import { useCreateTake } from '../../lib/queries-media.ts';
import { MediaErrorNotice, MiniTag } from '../media/shared.tsx';
import { nextClipHint, nextTakeNo, parseLabels, slateCode, type ShotRef } from './model.ts';
import { RatingPicker } from './RatingPicker.tsx';

/**
 * Main area of the set page: the current shot in large type, and the quick
 * take form. Enter saves; digits 1/2/3/0 rate while no text field has focus.
 * After a save the take number moves on and the clip name counts up, so the
 * next take is usually one keystroke.
 */

const CAMERAS = ['A', 'B', 'C'] as const;

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}

export interface TakeFormProps {
  current: ShotRef;
  /** other shots this take also covers */
  extras: ShotRef[];
  onRemoveExtra: (id: string) => void;
  takes: readonly Take[];
  codeFormat: string;
  setupId: string | null;
  onSaved: (take: Take) => void;
}

export function CurrentShotCard({ current, nextTake, codeFormat }: { current: ShotRef; nextTake: number; codeFormat: string }) {
  const f = current.shot.fields;
  const slate = slateCode(codeFormat, current.scene_no, current.shot.code, nextTake);
  return (
    <div className="flex flex-col gap-2 rounded-panel border border-graphite-700 bg-graphite-800 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-graphite-300">
        <span>
          第 {current.scene_no} 场 · 镜 {current.shot.code}
        </span>
        <span className="min-w-0 truncate">{current.scene_heading}</span>
        <span className="ml-auto">
          <MiniTag>{REQUIRED_LABEL[current.shot.required_status]}</MiniTag>
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <p aria-label={`当前镜头 ${current.label}`} className="text-[56px] leading-none font-medium tracking-tight text-graphite-100 tabular-nums md:text-[72px]">
          {current.label}
        </p>
        <div className="flex flex-col gap-0.5 pb-1">
          <span className="text-xs text-graphite-300">下一条</span>
          <span className="text-xl font-medium text-graphite-100 tabular-nums">T{String(nextTake).padStart(2, '0')}</span>
        </div>
        {slate ? (
          <div className="flex flex-col gap-0.5 pb-1">
            <span className="text-xs text-graphite-300">打板编号</span>
            <span className="font-mono text-sm text-graphite-100">{slate}</span>
          </div>
        ) : null}
      </div>
      <p className="text-sm text-graphite-300">
        {ZH_SHOT_SIZE[f.shot_size]} · {ZH_CAMERA_ANGLE[f.angle]} · {ZH_MOVEMENT[f.movement]}
        {f.focal_mm ? ` · ${f.focal_mm}mm` : ''}
      </p>
      {f.action ? <p className="text-sm text-graphite-100">{f.action}</p> : null}
    </div>
  );
}

export function TakeForm({ current, extras, onRemoveExtra, takes, codeFormat, setupId, onSaved }: TakeFormProps) {
  const create = useCreateTake();
  const formRef = useRef<HTMLFormElement>(null);
  const [takeNoText, setTakeNoText] = useState<string | null>(null);
  const [camera, setCamera] = useState('A');
  const [rating, setRating] = useState<TakeRating>('unrated');
  const [clip, setClip] = useState('');
  const [notes, setNotes] = useState('');
  const [labelsText, setLabelsText] = useState('');
  const [labelsOnly, setLabelsOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const ids = useId();

  const shotIds = labelsOnly ? [] : [current.shot.id, ...extras.map((e) => e.shot.id)];
  const autoNo = nextTakeNo(takes, shotIds);
  const takeNo = takeNoText === null ? autoNo : Number(takeNoText);

  // a different shot set starts over with its own take number
  const setKey = shotIds.join('|');
  useEffect(() => {
    setTakeNoText(null);
    setSaved(null);
    setError(null);
  }, [setKey]);

  // page-wide rating keys and Enter outside text fields
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      const active = document.activeElement;
      if (isTyping(active)) return;
      const r = ratingForKey(e.key);
      if (r) {
        e.preventDefault();
        setRating(r);
        return;
      }
      if (e.key === 'Enter' && (active === document.body || active === null)) {
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const labels = parseLabels(labelsText);
    if (takeNoText !== null && (!/^\d+$/.test(takeNoText.trim()) || Number(takeNoText) < 1)) {
      setError('条次号需要是正整数');
      return;
    }
    if (shotIds.length === 0 && labels.length === 0) {
      setError('只记手写镜号时，请填写对不上的镜号');
      return;
    }
    setError(null);
    create.mutate(
      {
        setup_id: labelsOnly ? null : setupId,
        ...(takeNoText === null ? {} : { take_no: takeNo }),
        camera_label: camera.trim() || null,
        rating,
        clip_hint: clip.trim() || null,
        notes: notes.trim(),
        shot_ids: shotIds,
        unresolved_labels: labels,
      },
      {
        onSuccess: (take) => {
          setSaved(`已记录 T${String(take.take_no).padStart(2, '0')}`);
          setTakeNoText(null);
          setRating('unrated');
          setNotes('');
          setClip(nextClipHint(take.clip_hint) ?? '');
          onSaved(take);
        },
      },
    );
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label="新增条次">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-graphite-100">本条覆盖</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {labelsOnly ? (
            <span className="text-sm text-graphite-300">不关联镜头，只记手写镜号</span>
          ) : (
            <>
              <span className="inline-flex h-6 items-center rounded-control border border-graphite-500 bg-graphite-800 px-2 text-sm text-graphite-100 tabular-nums">
                {current.label}
              </span>
              {extras.map((x) => (
                <span key={x.shot.id} className="inline-flex h-6 items-center gap-1 rounded-control border border-graphite-700 bg-graphite-800 pr-0.5 pl-2 text-sm text-graphite-100 tabular-nums">
                  {x.label}
                  <button
                    type="button"
                    onClick={() => onRemoveExtra(x.shot.id)}
                    aria-label={`从本条移除 ${x.label}`}
                    className="inline-flex size-5 items-center justify-center rounded-control text-graphite-300 hover:bg-graphite-700 hover:text-graphite-100"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </span>
              ))}
              <span className="text-xs text-graphite-300">{extras.length === 0 ? '一条拍了几个镜头时，在镜头列表里勾选其余镜头。' : `一条覆盖 ${extras.length + 1} 个镜头`}</span>
            </>
          )}
        </div>
      </fieldset>

      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-3 sm:grid-cols-[88px_minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-no`} className="text-xs font-medium text-graphite-100">
            条次号
          </label>
          <TextInput
            id={`${ids}-no`}
            inputMode="numeric"
            value={takeNoText ?? String(autoNo)}
            onChange={(e) => setTakeNoText(e.target.value)}
            className="text-center text-base font-medium tabular-nums"
            aria-describedby={`${ids}-no-hint`}
          />
          <span id={`${ids}-no-hint`} className="text-xs text-graphite-300">
            {takeNoText === null ? '自动' : '手动'}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-cam`} className="text-xs font-medium text-graphite-100">
            机位
          </label>
          <div className="flex gap-1">
            {CAMERAS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={camera === c}
                onClick={() => setCamera(c)}
                className={
                  'h-7 w-8 shrink-0 rounded-control border text-sm ' +
                  (camera === c ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950' : 'border-graphite-700 bg-graphite-800 text-graphite-100 hover:border-graphite-500')
                }
              >
                {c}
              </button>
            ))}
            <TextInput
              id={`${ids}-cam`}
              aria-label="其他机位"
              value={(CAMERAS as readonly string[]).includes(camera) ? '' : camera}
              onChange={(e) => setCamera(e.target.value)}
              placeholder="其他"
              className="w-16 min-w-0 flex-1"
              autoComplete="off"
            />
          </div>
        </div>
        <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
          <span className="text-xs font-medium text-graphite-100">评级</span>
          <RatingPicker value={rating} onChange={setRating} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-clip`} className="text-xs font-medium text-graphite-100">
            机内文件名
          </label>
          <TextInput
            id={`${ids}-clip`}
            value={clip}
            onChange={(e) => setClip(e.target.value)}
            placeholder="如 A001C003"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="characters"
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-notes`} className="text-xs font-medium text-graphite-100">
            备注
          </label>
          <TextInput id={`${ids}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="跑焦、穿帮、表演亮点…" autoComplete="off" />
        </div>
      </div>

      <details className="group text-sm" open={labelsOnly || labelsText !== '' ? true : undefined}>
        <summary className="cursor-pointer text-xs text-graphite-300 select-none hover:text-graphite-100">镜号对不上？</summary>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-labels`} className="text-xs font-medium text-graphite-100">
              手写镜号
            </label>
            <TextInput
              id={`${ids}-labels`}
              value={labelsText}
              onChange={(e) => setLabelsText(e.target.value)}
              placeholder="场记单上写的编号，多个用逗号分开，如 3A-2, 12"
              autoComplete="off"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-graphite-100">
            <input type="checkbox" checked={labelsOnly} onChange={(e) => setLabelsOnly(e.target.checked)} className="size-3.5" />
            这一条不关联当前镜头，只记手写镜号
          </label>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" busy={create.isPending}>
          保存条次
          <CornerDownLeft aria-hidden className="size-3.5" />
        </Button>
        <p role="status" aria-live="polite" className="text-sm text-graphite-300 tabular-nums">
          {saved}
        </p>
      </div>
      <p className="text-xs text-graphite-300">
        快捷键：<kbd className="font-sans">1</kbd> 好 · <kbd className="font-sans">2</kbd> 备选 · <kbd className="font-sans">3</kbd> 废 ·{' '}
        <kbd className="font-sans">0</kbd> 未评（光标不在输入框时） · <kbd className="font-sans">Enter</kbd> 保存 · 镜头列表里 <kbd className="font-sans">↑</kbd>
        <kbd className="font-sans">↓</kbd> 换镜头
      </p>
      {error ? (
        <p role="alert" className="text-sm text-graphite-100">
          {error}
        </p>
      ) : null}
      {create.isError ? <MediaErrorNotice error={create.error} /> : null}
    </form>
  );
}
