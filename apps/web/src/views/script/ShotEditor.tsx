import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BoardTemplate,
  CameraAngle,
  DepthPlane,
  EnvKind,
  Facing,
  FrameFormat,
  LensClass,
  Movement,
  Pose,
  PropKind,
  ScreenPos,
  ShotFields,
  ShotSize,
  SubjectMotion,
  type Scene,
  type Shot,
  type ShotSubject,
} from '@storyscript/contracts';
import { TECHNIQUES } from '@storyscript/core';
import { Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { isRevisionConflict } from '../../lib/errors.ts';
import {
  ANGLE_LABEL,
  DEPTH_LABEL,
  ENV_LABEL,
  FACING_LABEL,
  FRAME_FORMAT_LABEL,
  LENS_LABEL,
  MOVEMENT_LABEL,
  POSE_LABEL,
  PROP_LABEL,
  SCREEN_POS_LABEL,
  SHOT_SIZE_LABEL,
  SUBJECT_MOTION_LABEL,
  TEMPLATE_LABEL,
} from '../../lib/labels.ts';
import { keys, useCreateShot, useUpdateShot } from '../../lib/queries.ts';
import { emptyShotFields, emptySubject, linesToList, parseNumberField } from '../../lib/shots.ts';
import { stableKey } from '../../lib/stable.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Note, Select, TextArea, TextInput } from '../../components/ui.tsx';
import { useWorkspace } from './context.ts';

// ------------------------------------------------------------ primitives ---

function EnumSelect<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
  nullLabel,
  className = '',
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T | null) => void;
  /** when set, the select offers a null option with this label */
  nullLabel?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as T))}>
        {nullLabel !== undefined ? <option value="">{nullLabel}</option> : null}
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o]}
          </option>
        ))}
      </Select>
    </div>
  );
}

function Labeled({ label, children, hint, error, className = '' }: { label: string; children: (id: string) => ReactNode; hint?: string; error?: string | null; className?: string }) {
  const id = useId();
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 border-t border-rule pt-3 first:border-t-0 first:pt-0">
      <legend className="float-left mb-2 w-full text-[13px] font-semibold text-ink">{title}</legend>
      <div className="clear-both">{children}</div>
    </fieldset>
  );
}

// ------------------------------------------------------------------ form ---

interface FormState {
  fields: ShotFields;
  focal: string;
  est: string;
  dialogue: string;
  assumptions: string;
  questions: string;
  /** '' = no source paragraph chosen (manual shots only) */
  sourcePid: string;
  sourceQuote: string;
  code: string;
  manualNote: string;
  reason: string;
}

function toForm(fields: ShotFields, code: string, hasSource: boolean): FormState {
  return {
    fields,
    focal: fields.focal_mm === null ? '' : String(fields.focal_mm),
    est: String(fields.est_seconds),
    dialogue: fields.dialogue_quote ?? '',
    assumptions: fields.assumptions.join('\n'),
    questions: fields.questions.join('\n'),
    sourcePid: hasSource ? fields.source.paragraph_id : '',
    sourceQuote: hasSource ? fields.source.quote : '',
    code,
    manualNote: '',
    reason: '',
  };
}

/** A manual shot saved without a paragraph carries an empty quote (see submit). */
function formFromShot(shot: Shot): FormState {
  const hasSource = !(shot.origin === 'manual' && shot.fields.source.quote.trim() === '');
  return toForm(shot.fields, shot.code, hasSource);
}

type Errors = Partial<Record<'focal' | 'est' | 'manualNote' | 'form', string>>;

export type EditorTarget = { mode: 'edit'; shot: Shot } | { mode: 'create'; scene: Scene };

export function ShotEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const update = useUpdateShot();
  const create = useCreateShot();

  const editing = target.mode === 'edit' ? target.shot : null;
  const scene = target.mode === 'create' ? target.scene : (ws.script.scenes.find((s) => s.id === editing?.scene_id) ?? null);

  // Snapshot of the revision the user started from (INV-03 optimistic concurrency).
  const [base, setBase] = useState<Shot | null>(editing);
  const [form, setForm] = useState<FormState>(() =>
    editing ? formFromShot(editing) : toForm(emptyShotFields(scene ?? { paragraph_ids: [] }), '', false),
  );
  const [errors, setErrors] = useState<Errors>({});
  const locked = base?.locked ?? false;

  const setF = <K extends keyof ShotFields>(k: K, v: ShotFields[K]) => setForm((f) => ({ ...f, fields: { ...f.fields, [k]: v } }));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const paragraphOptions = useMemo(() => {
    const ids = scene ? scene.paragraph_ids : [...ws.paragraphs.keys()];
    const list = ids.map((id) => ws.paragraphs.get(id)).filter((p) => p !== undefined);
    return list;
  }, [scene, ws.paragraphs]);
  const chosenParagraph = form.sourcePid ? ws.paragraphs.get(form.sourcePid) : undefined;
  const quoteMissing = chosenParagraph !== undefined && form.sourceQuote.trim() !== '' && !chosenParagraph.text.includes(form.sourceQuote.trim());
  const staleSource = form.sourcePid !== '' && !paragraphOptions.some((p) => p.id === form.sourcePid);

  const characterAliases = ws.characters.map((c) => c.alias);
  const aliasOptions = (current: string) => (current && !characterAliases.includes(current) ? [current, ...characterAliases] : characterAliases);

  const setSubject = (i: number, patch: Partial<ShotSubject>) =>
    setF(
      'subjects',
      form.fields.subjects.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    );

  const conflict = isRevisionConflict(update.error);
  const pending = update.isPending || create.isPending;

  const reloadLatest = async () => {
    if (!editing) return;
    await qc.invalidateQueries({ queryKey: keys.shots, exact: true });
    const latest = qc.getQueryData<Shot[]>(keys.shots)?.find((s) => s.id === editing.id) ?? null;
    if (latest) {
      setBase(latest);
      setForm(formFromShot(latest));
      update.reset();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    const focal = parseNumberField(form.focal, { allowEmpty: true, min: 1, max: 2000, label: '焦段' });
    const est = parseNumberField(form.est, { allowEmpty: false, min: 0.1, max: 3600, label: '预计时长' });
    if (focal.error) next.focal = focal.error;
    if (est.error) next.est = est.error;
    if (!editing && form.manualNote.trim() === '') next.manualNote = '手工镜头需要说明来由，例如"导演补充的空镜"';

    // Contract: ShotFields.source is required. A manual shot without a chosen
    // paragraph is anchored to the scene heading with an empty quote.
    const fallbackPid = scene?.paragraph_ids[0] ?? form.fields.source.paragraph_id;
    const source = form.sourcePid ? { paragraph_id: form.sourcePid, quote: form.sourceQuote.trim() } : { paragraph_id: fallbackPid, quote: '' };

    const fields: ShotFields = {
      ...form.fields,
      focal_mm: focal.value,
      est_seconds: est.value ?? form.fields.est_seconds,
      dialogue_quote: form.dialogue.trim() === '' ? null : form.dialogue.trim(),
      narrative_purpose: form.fields.narrative_purpose.trim(),
      action: form.fields.action.trim(),
      assumptions: linesToList(form.assumptions),
      questions: linesToList(form.questions),
      source,
    };
    const parsed = ShotFields.safeParse(fields);
    if (!parsed.success) next.form = `字段不符合要求：${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message ?? ''}`;
    setErrors(next);
    if (Object.keys(next).length > 0 || !parsed.success) return;

    if (editing && base) {
      const code = form.code.trim();
      const fieldsChanged = stableKey(parsed.data) !== stableKey(base.fields);
      const codeChanged = code !== '' && code !== base.code;
      if (!fieldsChanged && !codeChanged) {
        onClose();
        return;
      }
      update.mutate(
        {
          id: base.id,
          input: {
            expected_revision: base.revision,
            fields: fieldsChanged ? parsed.data : undefined,
            code: codeChanged ? code : undefined,
            reason: form.reason.trim() || undefined,
          },
        },
        { onSuccess: onClose },
      );
    } else if (scene) {
      create.mutate(
        { scene_id: scene.id, fields: parsed.data, manual_note: form.manualNote.trim(), code: form.code.trim() || undefined },
        {
          onSuccess: (shot) => {
            ws.notify(`已新建镜头 ${shot.code}。`);
            onClose();
          },
        },
      );
    }
  };

  const title = editing ? `编辑镜头 ${base?.code ?? ''}` : `新建手工镜头 · 第 ${scene?.display_no ?? ''} 场`;
  const f = form.fields;

  return (
    <Dialog
      open
      onClose={onClose}
      variant="drawer"
      busy={pending}
      title={title}
      description={scene ? `${scene.display_no} ${scene.heading}` : '这个镜头所属的场景不在当前剧本版本中'}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" form="shot-editor-form" variant="primary" busy={pending} disabled={locked || (!editing && !scene)}>
            {editing ? '保存' : '新建镜头'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            取消
          </Button>
          {editing ? <span className="ml-auto font-mono text-xs text-ink-3">r{base?.revision}</span> : null}
        </div>
      }
    >
      <form id="shot-editor-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {locked ? (
          <Note tone="warn">
            <Lock aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
            镜头已锁定，内容不能修改。先在镜头表里解锁。
          </Note>
        ) : null}
        {conflict ? (
          <div className="flex flex-col gap-2">
            <ErrorNotice error={update.error} context="shot-save" />
            <div>
              <Button onClick={() => void reloadLatest()}>
                <RefreshCw aria-hidden className="size-3.5" />
                放弃我的修改，载入最新版本
              </Button>
            </div>
          </div>
        ) : update.isError ? (
          <ErrorNotice error={update.error} context="shot-save" />
        ) : null}
        {create.isError ? <ErrorNotice error={create.error} context="shot-save" /> : null}

        <fieldset disabled={locked || pending} className="flex min-w-0 flex-col gap-4">
          <Section title="编号与模板">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Labeled label="镜号" hint={editing ? '只是显示编号，可随时修改' : '留空自动分配'}>
                {(id) => <TextInput id={id} value={form.code} onChange={(e) => set('code', e.target.value)} className="font-mono" maxLength={40} />}
              </Labeled>
              <EnumSelect label="构图模板" value={f.template} options={BoardTemplate.options} labels={TEMPLATE_LABEL} nullLabel="自动推导" onChange={(v) => setF('template', v)} />
              <EnumSelect label="画幅" value={f.frame_format} options={FrameFormat.options} labels={FRAME_FORMAT_LABEL} nullLabel="沿用项目画幅" onChange={(v) => setF('frame_format', v)} />
              <Labeled label="手法">
                {(id) => (
                  <Select id={id} value={f.technique_id ?? ''} onChange={(e) => setF('technique_id', e.target.value || null)}>
                    <option value="">无</option>
                    {TECHNIQUES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                    {f.technique_id && !TECHNIQUES.some((t) => t.id === f.technique_id) ? <option value={f.technique_id}>{f.technique_id}</option> : null}
                  </Select>
                )}
              </Labeled>
            </div>
          </Section>

          <Section title="机位">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <EnumSelect label="景别" value={f.shot_size} options={ShotSize.options} labels={SHOT_SIZE_LABEL} onChange={(v) => v && setF('shot_size', v)} />
              <EnumSelect label="角度" value={f.angle} options={CameraAngle.options} labels={ANGLE_LABEL} onChange={(v) => v && setF('angle', v)} />
              <EnumSelect label="镜头" value={f.lens} options={LensClass.options} labels={LENS_LABEL} onChange={(v) => v && setF('lens', v)} />
              <Labeled label="焦段（mm）" error={errors.focal}>
                {(id) => (
                  <TextInput id={id} value={form.focal} onChange={(e) => set('focal', e.target.value)} inputMode="decimal" placeholder="不指定" className="tabular-nums" aria-invalid={Boolean(errors.focal) || undefined} />
                )}
              </Labeled>
              <EnumSelect label="运动" value={f.movement} options={Movement.options} labels={MOVEMENT_LABEL} onChange={(v) => v && setF('movement', v)} />
            </div>
          </Section>

          <Section title="画面">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-ink-2">人物</p>
              {f.subjects.length === 0 ? <p className="text-xs text-ink-3">画面里没有人物。</p> : null}
              {f.subjects.map((s, i) => (
                <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-sheet border border-rule bg-sheet-sunk/40 p-2 sm:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto]">
                  <Labeled label="角色" className="col-span-2 sm:col-span-1">
                    {(id) => (
                      <Select id={id} value={s.alias} onChange={(e) => setSubject(i, { alias: e.target.value })}>
                        {aliasOptions(s.alias).map((a) => (
                          <option key={a} value={a}>
                            {ws.aliasLabel(a)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Labeled>
                  <EnumSelect label="画面位置" value={s.screen} options={ScreenPos.options} labels={SCREEN_POS_LABEL} nullLabel="—" onChange={(v) => setSubject(i, { screen: v })} />
                  <EnumSelect label="景深" value={s.depth} options={DepthPlane.options} labels={DEPTH_LABEL} nullLabel="—" onChange={(v) => setSubject(i, { depth: v })} />
                  <EnumSelect label="朝向" value={s.facing} options={Facing.options} labels={FACING_LABEL} nullLabel="—" onChange={(v) => setSubject(i, { facing: v })} />
                  <EnumSelect label="姿势" value={s.pose} options={Pose.options} labels={POSE_LABEL} nullLabel="—" onChange={(v) => setSubject(i, { pose: v })} />
                  <button
                    type="button"
                    onClick={() =>
                      setF(
                        'subjects',
                        f.subjects.filter((_, j) => j !== i),
                      )
                    }
                    className="inline-flex h-8 items-center justify-center gap-1 rounded-control px-2 text-xs text-ink-3 hover:enabled:bg-sheet hover:enabled:text-danger"
                    aria-label={`移除人物 ${ws.aliasLabel(s.alias)}`}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                    <span className="sm:hidden">移除</span>
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="h-7 px-2 text-xs"
                  disabled={characterAliases.length === 0}
                  onClick={() => {
                    const used = new Set(f.subjects.map((s) => s.alias));
                    const alias = characterAliases.find((a) => !used.has(a)) ?? characterAliases[0];
                    if (alias) setF('subjects', [...f.subjects, emptySubject(alias)]);
                  }}
                >
                  <Plus aria-hidden className="size-3.5" />
                  添加人物
                </Button>
                {characterAliases.length === 0 ? <span className="text-xs text-ink-3">先在"角色 · 地点 · 道具"里新增角色。</span> : null}
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <p className="text-xs font-medium text-ink-2">道具与陈设</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="道具与陈设">
                {PropKind.options.map((p) => {
                  const on = f.props.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setF('props', on ? f.props.filter((x) => x !== p) : [...f.props, p])}
                      className={`h-7 rounded-control border px-2 text-xs ${on ? 'border-graphite bg-graphite text-sheet' : 'border-rule-strong bg-sheet text-ink-2 hover:enabled:text-ink'}`}
                    >
                      {PROP_LABEL[p]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <EnumSelect label="环境" value={f.env} options={EnvKind.options} labels={ENV_LABEL} nullLabel="—" onChange={(v) => setF('env', v)} />
              <EnumSelect label="主体运动" value={f.subject_motion} options={SubjectMotion.options} labels={SUBJECT_MOTION_LABEL} onChange={(v) => v && setF('subject_motion', v)} />
              <Labeled label="视点人物">
                {(id) => (
                  <Select id={id} value={f.pov_owner ?? ''} onChange={(e) => setF('pov_owner', e.target.value || null)}>
                    <option value="">无</option>
                    {aliasOptions(f.pov_owner ?? '').map((a) => (
                      <option key={a} value={a}>
                        {ws.aliasLabel(a)}
                      </option>
                    ))}
                  </Select>
                )}
              </Labeled>
              <label className="flex items-center gap-2 self-end pb-1.5 text-[13px] text-ink">
                <input type="checkbox" checked={f.set_piece} onChange={(e) => setF('set_piece', e.target.checked)} className="size-4 accent-graphite" />
                重点段落（大动作、载具、大场面）
              </label>
            </div>
          </Section>

          <Section title="内容">
            <div className="grid gap-3">
              <Labeled label="叙事作用" hint="观众从这个镜头得到什么信息或情绪">
                {(id) => <TextInput id={id} value={f.narrative_purpose} onChange={(e) => setF('narrative_purpose', e.target.value)} maxLength={200} />}
              </Labeled>
              <Labeled label="动作">
                {(id) => <TextArea id={id} value={f.action} onChange={(e) => setF('action', e.target.value)} rows={2} maxLength={500} />}
              </Labeled>
              <Labeled label="台词" hint="本镜头内出现的台词原文，没有就留空">
                {(id) => <TextArea id={id} value={form.dialogue} onChange={(e) => set('dialogue', e.target.value)} rows={2} maxLength={1000} />}
              </Labeled>
              <Labeled label="预计时长（秒）" hint="成片中的时长，不是拍摄工时" error={errors.est} className="max-w-[12rem]">
                {(id) => <TextInput id={id} value={form.est} onChange={(e) => set('est', e.target.value)} inputMode="decimal" className="tabular-nums" aria-invalid={Boolean(errors.est) || undefined} />}
              </Labeled>
            </div>
          </Section>

          <Section title="剧本出处">
            <div className="grid gap-3">
              <Labeled label="段落" hint={editing ? undefined : '可以不选：手工镜头允许没有出处。'}>
                {(id) => (
                  <Select id={id} value={form.sourcePid} onChange={(e) => set('sourcePid', e.target.value)}>
                    {!editing || form.sourcePid === '' ? <option value="">不关联段落</option> : null}
                    {staleSource ? <option value={form.sourcePid}>{form.sourcePid}（不在当前场景）</option> : null}
                    {paragraphOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} · {p.text.length > 28 ? `${p.text.slice(0, 28)}…` : p.text}
                      </option>
                    ))}
                  </Select>
                )}
              </Labeled>
              {chosenParagraph ? <p className="rounded-control bg-sheet-sunk px-2.5 py-1.5 text-[13px] break-words whitespace-pre-wrap text-ink-2">{chosenParagraph.text}</p> : null}
              {form.sourcePid ? (
                <Labeled label="引用原文" hint="从上面的段落里复制一段连续原文，用来定位和对照新版本。">
                  {(id) => <TextArea id={id} value={form.sourceQuote} onChange={(e) => set('sourceQuote', e.target.value)} rows={2} maxLength={400} />}
                </Labeled>
              ) : null}
              {quoteMissing ? <Note tone="warn">这段引用在所选段落里找不到逐字相同的原文，保存后可能被标为"待重新关联"。</Note> : null}
            </div>
          </Section>

          <Section title="假设与待确认问题">
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="假设" hint="每行一条">
                {(id) => <TextArea id={id} value={form.assumptions} onChange={(e) => set('assumptions', e.target.value)} rows={3} />}
              </Labeled>
              <Labeled label="待确认问题" hint="每行一条">
                {(id) => <TextArea id={id} value={form.questions} onChange={(e) => set('questions', e.target.value)} rows={3} />}
              </Labeled>
            </div>
          </Section>

          {editing ? (
            <Section title="修改说明">
              <Labeled label="说明（可选）" hint="记入修订历史">
                {(id) => <TextInput id={id} value={form.reason} onChange={(e) => set('reason', e.target.value)} maxLength={300} placeholder="例如：按勘景结果改为长焦" />}
              </Labeled>
            </Section>
          ) : (
            <Section title="手工说明">
              <Labeled label="为什么加这个镜头（必填）" error={errors.manualNote}>
                {(id) => (
                  <TextArea
                    id={id}
                    value={form.manualNote}
                    onChange={(e) => set('manualNote', e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder="例如：导演补充的空镜，交代时间流逝"
                    aria-invalid={Boolean(errors.manualNote) || undefined}
                  />
                )}
              </Labeled>
            </Section>
          )}

          {errors.form ? <p className="text-xs text-danger">{errors.form}</p> : null}
        </fieldset>
      </form>
    </Dialog>
  );
}
