import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
import { Check, Copy, History, Lock, LockOpen, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { unsavedShotText, useCollabFeed, watchersOf, watchersText } from '../../lib/collab.ts';
import { isRevisionConflict } from '../../lib/errors.ts';
import {
  ANGLE_LABEL,
  DEPTH_LABEL,
  ENV_LABEL,
  FACING_LABEL,
  FRAME_FORMAT_LABEL,
  LENS_LABEL,
  MOVEMENT_LABEL,
  ORIGIN_LABEL,
  POSE_LABEL,
  PROP_LABEL,
  QUOTE_MATCH_LABEL,
  REQUIRED_STATUS_LABEL,
  SCREEN_POS_LABEL,
  SHOT_SIZE_LABEL,
  SUBJECT_MOTION_LABEL,
  TEMPLATE_LABEL,
} from '../../lib/labels.ts';
import { polishAiReason } from '../../lib/polish.ts';
import { useCreateShot, useHealth, useUpdateShot } from '../../lib/queries.ts';
import { emptyShotFields, emptySubject, linesToList, parseNumberField, revisionLabel } from '../../lib/shots.ts';
import { stableKey } from '../../lib/stable.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, IconButton, Notice, SelectInput, Tag, TextArea, TextInput } from '../../components/ui.tsx';
import { FormRow } from './SceneInspector.tsx';
import { useWorkspace } from './context.ts';
import { useGoneShotId } from './goneShot.ts';

/**
 * Shot inspector: every ShotFields field (enums as Chinese dropdowns), saved
 * with expected_revision (409 → reload prompt). The same form creates manual
 * shots, with a required manual note and an optional source paragraph.
 */

/** Server business bounds (core validateShotFieldsBasic). */
const EST_SECONDS_MAX = 120;
const CAMERA_NOTES_MAX = 300;

/** Old shots have no camera_notes key; null, '' and a missing key all mean "no notes". */
function withoutEmptyNotes(fields: ShotFields): ShotFields {
  const { camera_notes, ...rest } = fields;
  return typeof camera_notes === 'string' && camera_notes.trim() !== '' ? { ...rest, camera_notes } : (rest as ShotFields);
}

// ------------------------------------------------------------ primitives ---

function Group({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="py-3 first:pt-2">
      <div className="flex min-h-6 items-center justify-between gap-2 px-3">
        <h3 id={id} className="text-xs font-medium text-graphite-100">
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <div className="mt-2 flex flex-col gap-2 px-3">{children}</div>
    </section>
  );
}

function EnumRow<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
  nullLabel,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T | null) => void;
  /** when set, the select offers a null option with this label */
  nullLabel?: string;
}) {
  return (
    <FormRow label={label}>
      {(id) => (
        <SelectInput id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as T))}>
          {nullLabel !== undefined ? <option value="">{nullLabel}</option> : null}
          {options.map((o) => (
            <option key={o} value={o}>
              {labels[o]}
            </option>
          ))}
        </SelectInput>
      )}
    </FormRow>
  );
}

function Stacked({ label, children, hint, error }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-graphite-300">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-graphite-100">{error}</p> : hint ? <p className="text-xs text-graphite-300">{hint}</p> : null}
    </div>
  );
}

function MiniSelect<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T | null) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <label htmlFor={id} className="text-xs text-graphite-300">
        {label}
      </label>
      <SelectInput id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as T))}>
        <option value="">默认</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o]}
          </option>
        ))}
      </SelectInput>
    </div>
  );
}

// ------------------------------------------------------------------ form ---

interface FormState {
  fields: ShotFields;
  focal: string;
  est: string;
  dialogue: string;
  /** ShotFields.camera_notes (missing/null → '') */
  notes: string;
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
    notes: fields.camera_notes ?? '',
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

/**
 * A teammate archived this shot while it was being edited (S4a; the workspace
 * says so through GoneShotContext): the editor stays with what was typed,
 * saving is off, and the person copies the text or lets go.
 */
export function ShotEditor({ target }: { target: EditorTarget }) {
  const ws = useWorkspace();
  const goneId = useGoneShotId();
  const gone = target.mode === 'edit' && goneId === target.shot.id;
  const hosted = useHealth().data?.hosted ?? false;
  const feed = useCollabFeed();
  const [copied, setCopied] = useState(false);
  const update = useUpdateShot();
  const lockToggle = useUpdateShot();
  const create = useCreateShot();

  const latest = target.mode === 'edit' ? target.shot : null;
  const scene = target.mode === 'create' ? target.scene : (ws.script.scenes.find((s) => s.id === latest?.scene_id) ?? null);

  // The revision the user started from (INV-03 optimistic concurrency).
  const [base, setBase] = useState<Shot | null>(latest);
  const initial = useMemo(
    () => (base ? formFromShot(base) : toForm(emptyShotFields(scene ?? { paragraph_ids: [] }), '', false)),
    // the create form starts once per scene
    [base, scene],
  );
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const dirty = stableKey(form) !== stableKey(initial);
  const locked = base?.locked ?? false;
  const watching = watchersText(watchersOf(base?.id ?? null, feed.presence));
  const staleBase = latest !== null && base !== null && latest.revision !== base.revision;

  const { setEditorDirty } = ws;
  useEffect(() => {
    setEditorDirty(dirty);
    return () => setEditorDirty(false);
  }, [dirty, setEditorDirty]);

  // Picked up a newer revision (lock toggled in the table, another tab…): follow it unless the user has edits.
  useEffect(() => {
    if (!latest || !base || latest.revision === base.revision || dirty) return;
    setBase(latest);
    setForm(formFromShot(latest));
    update.reset();
  }, [latest]); // only a new server revision triggers this

  const setF = <K extends keyof ShotFields>(k: K, v: ShotFields[K]) => setForm((f) => ({ ...f, fields: { ...f.fields, [k]: v } }));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const paragraphOptions = useMemo(() => {
    const ids = scene ? scene.paragraph_ids : [...ws.paragraphs.keys()];
    return ids.map((id) => ws.paragraphs.get(id)).filter((p) => p !== undefined);
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

  const reloadLatest = () => {
    if (!latest) return;
    setBase(latest);
    setForm(formFromShot(latest));
    setErrors({});
    update.reset();
  };

  const copyText = () => {
    const text = unsavedShotText({ action: form.fields.action, notes: form.notes, dialogue: form.dialogue, narrative: form.fields.narrative_purpose });
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };

  /** AI 润色 works on the saved shot: unsaved edits are dropped first, after asking (same question as switching away). */
  const startPolish = () => {
    if (!base) return;
    if (dirty) {
      if (!window.confirm('这个镜头有未保存的修改。润色用的是已保存的内容，放弃这些修改再继续吗？')) return;
      setForm(formFromShot(base));
      setErrors({});
      update.reset();
      ws.setEditorDirty(false);
    }
    ws.openPolish([base.id]);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    const focal = parseNumberField(form.focal, { allowEmpty: true, min: 1, max: 2000, label: '焦段' });
    const est = parseNumberField(form.est, { allowEmpty: false, min: 0.1, max: EST_SECONDS_MAX, label: '预计时长' });
    if (focal.error) next.focal = focal.error;
    if (est.error) next.est = est.error;
    if (!base && form.manualNote.trim() === '') next.manualNote = '手工镜头需要说明来由，例如"导演补充的空镜"';

    // Contract: ShotFields.source is required. A manual shot without a chosen
    // paragraph points at the scene heading with an empty quote.
    const fallbackPid = scene?.paragraph_ids[0] ?? form.fields.source.paragraph_id;
    const source = form.sourcePid ? { paragraph_id: form.sourcePid, quote: form.sourceQuote.trim() } : { paragraph_id: fallbackPid, quote: '' };

    const fields: ShotFields = {
      ...form.fields,
      focal_mm: focal.value,
      est_seconds: est.value ?? form.fields.est_seconds,
      dialogue_quote: form.dialogue.trim() === '' ? null : form.dialogue.trim(),
      camera_notes: form.notes.trim() === '' ? null : form.notes.trim(),
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

    if (base) {
      const code = form.code.trim();
      const fieldsChanged = stableKey(withoutEmptyNotes(parsed.data)) !== stableKey(withoutEmptyNotes(base.fields));
      const codeChanged = code !== '' && code !== base.code;
      if (!fieldsChanged && !codeChanged) {
        setForm(formFromShot(base));
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
        {
          onSuccess: (shot) => {
            setBase(shot);
            setForm(formFromShot(shot));
            setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
          },
        },
      );
    } else if (scene) {
      create.mutate(
        { scene_id: scene.id, fields: parsed.data, manual_note: form.manualNote.trim(), code: form.code.trim() || undefined },
        {
          onSuccess: (shot) => {
            ws.setEditorDirty(false);
            ws.notify(`已新建手工镜头 ${shot.code}。`);
            ws.selectShot(shot, { reveal: true });
          },
        },
      );
    }
  };

  const f = form.fields;
  const anchor = base?.source_anchor ?? null;

  return (
    <form onSubmit={submit} noValidate className="flex min-h-full flex-col">
      <div className="flex-1 divide-y divide-graphite-800">
        {base ? (
          <Group
            title="概况"
            actions={
              <>
                {base.locked ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={polishAiReason(ws.ai) !== null || pending || gone}
                    title={polishAiReason(ws.ai) ?? '让模型按方式和风格重写这个镜头，结果先进草案'}
                    onClick={startPolish}
                  >
                    <Sparkles aria-hidden className="size-3" />
                    AI 润色…
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  busy={lockToggle.isPending}
                  disabled={dirty || gone}
                  title={dirty ? '先保存或还原修改' : base.locked ? '解锁后才能修改' : '锁定后，AI 重新拆镜不会改动它'}
                  onClick={() =>
                    lockToggle.mutate(
                      { id: base.id, input: { expected_revision: base.revision, locked: !base.locked } },
                      {
                        onSuccess: (shot) => {
                          setBase(shot);
                          setForm(formFromShot(shot));
                        },
                      },
                    )
                  }
                >
                  {lockToggle.isPending ? null : base.locked ? <LockOpen aria-hidden className="size-3" /> : <Lock aria-hidden className="size-3" />}
                  {base.locked ? '解锁' : '锁定'}
                </Button>
                <IconButton icon={History} label="修订历史" onClick={() => ws.openRevisions(base)} />
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-1">
              <Tag>{ORIGIN_LABEL[base.origin]}</Tag>
              {base.locked ? (
                <Tag>
                  <Lock aria-hidden className="size-3" />
                  已锁定
                </Tag>
              ) : null}
              {base.required_status !== 'required' ? (
                <Tag tone={base.required_status === 'waived' ? 'danger' : 'neutral'} title={base.requirement_reason ?? undefined}>
                  {REQUIRED_STATUS_LABEL[base.required_status]}
                </Tag>
              ) : null}
              {base.needs_relink ? <Tag tone="warn">待重新关联</Tag> : null}
              {anchor?.match === 'fuzzy' ? <Tag tone="warn">{QUOTE_MATCH_LABEL.fuzzy}</Tag> : null}
              <span className="ml-auto text-xs text-graphite-300 tabular-nums" title="每次保存内容、镜号或锁定状态都会记一次修订">
                {revisionLabel(base.revision)}
              </span>
            </div>
            {base.manual_note ? <p className="text-xs break-words text-graphite-300">手工说明：{base.manual_note}</p> : null}
            {gone ? (
              <Notice tone="warn" role="alert" title={`${hosted ? '这个镜头刚被组员归档了' : '这个镜头刚在别处被归档了'}；你的修改还没保存`}>
                <p>它已经不在镜头表里，不能再保存。文字可以复制到别的镜头里。</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={copyText}>
                    {copied ? <Check aria-hidden className="size-3 text-ok" /> : <Copy aria-hidden className="size-3" />}
                    {copied ? '已复制' : '复制文字'}
                  </Button>
                  <Button size="sm" onClick={ws.closeInspector}>
                    放弃
                  </Button>
                </div>
              </Notice>
            ) : null}
            {watching ? <Notice tone="info" role="status" title={watching} /> : null}
            {locked ? (
              <Notice tone="info" title="镜头已锁定">
                内容不能修改，AI 重新拆镜也不会改动它。要修改先解锁。
              </Notice>
            ) : null}
            {base.needs_relink ? (
              <Notice tone="warn" title="剧本改版后，原引用找不到了">
                在下面"剧本出处"里重新选择段落并粘贴引用原文，保存后恢复关联。
              </Notice>
            ) : null}
            {staleBase ? (
              <Notice tone="warn" title={`这个镜头已在别处修改（${revisionLabel(base.revision)} → ${revisionLabel(latest?.revision ?? base.revision)}）`}>
                <p>保存会被拒绝。可以放弃你的修改，载入最新版本。</p>
                <Button size="sm" className="mt-1.5" onClick={reloadLatest}>
                  <RefreshCw aria-hidden className="size-3" />
                  载入最新版本
                </Button>
              </Notice>
            ) : null}
            {lockToggle.isError ? <ErrorNotice error={lockToggle.error} context="shot-save" /> : null}
          </Group>
        ) : (
          <Group title={`新建手工镜头 · 第 ${scene?.display_no ?? ''} 场`}>
            <p className="text-xs text-graphite-300">手工镜头不需要模型，镜号留空时自动分配。</p>
          </Group>
        )}

        <fieldset disabled={locked || pending} className="min-w-0 divide-y divide-graphite-800">
          <Group title="编号与构图">
            <FormRow label="镜号" hint={base ? '只是显示编号，不影响身份' : '留空自动分配'}>
              {(id) => <TextInput id={id} value={form.code} onChange={(e) => set('code', e.target.value)} className="tabular-nums" maxLength={40} />}
            </FormRow>
            <EnumRow label="构图模板" value={f.template} options={BoardTemplate.options} labels={TEMPLATE_LABEL} nullLabel="自动推导" onChange={(v) => setF('template', v)} />
            <EnumRow label="画幅" value={f.frame_format} options={FrameFormat.options} labels={FRAME_FORMAT_LABEL} nullLabel="沿用项目画幅" onChange={(v) => setF('frame_format', v)} />
            <FormRow label="手法">
              {(id) => (
                <SelectInput id={id} value={f.technique_id ?? ''} onChange={(e) => setF('technique_id', e.target.value || null)}>
                  <option value="">无</option>
                  {TECHNIQUES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  {f.technique_id && !TECHNIQUES.some((t) => t.id === f.technique_id) ? <option value={f.technique_id}>{f.technique_id}</option> : null}
                </SelectInput>
              )}
            </FormRow>
          </Group>

          <Group title="机位">
            <EnumRow label="景别" value={f.shot_size} options={ShotSize.options} labels={SHOT_SIZE_LABEL} onChange={(v) => v && setF('shot_size', v)} />
            <EnumRow label="角度" value={f.angle} options={CameraAngle.options} labels={ANGLE_LABEL} onChange={(v) => v && setF('angle', v)} />
            <EnumRow label="镜头" value={f.lens} options={LensClass.options} labels={LENS_LABEL} onChange={(v) => v && setF('lens', v)} />
            <FormRow label="焦段 mm" hint={errors.focal ?? undefined}>
              {(id) => (
                <TextInput
                  id={id}
                  value={form.focal}
                  onChange={(e) => set('focal', e.target.value)}
                  inputMode="decimal"
                  placeholder="不指定"
                  className="tabular-nums"
                  aria-invalid={Boolean(errors.focal) || undefined}
                />
              )}
            </FormRow>
            <EnumRow label="运动" value={f.movement} options={Movement.options} labels={MOVEMENT_LABEL} onChange={(v) => v && setF('movement', v)} />
            <Stacked
              label="拍法说明"
              hint={
                <>
                  走位、器材和节奏等枚举写不下的内容 · <span className="tabular-nums">{form.notes.length}/{CAMERA_NOTES_MAX}</span>
                </>
              }
            >
              {(id) => (
                <TextArea
                  id={id}
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  rows={3}
                  maxLength={CAMERA_NOTES_MAX}
                  placeholder="例如：摄影师倒退跟拍穿过走廊，转进楼梯间后升到俯拍"
                />
              )}
            </Stacked>
          </Group>

          <Group title={`人物 ${f.subjects.length}`}>
            {f.subjects.length === 0 ? <p className="text-xs text-graphite-300">画面里没有人物。</p> : null}
            {f.subjects.map((s, i) => (
              <div key={i} className="flex flex-col gap-1.5 rounded-panel border border-graphite-800 bg-graphite-950/40 p-2">
                <div className="flex items-center gap-1">
                  <SelectInput aria-label={`人物 ${i + 1}`} value={s.alias} onChange={(e) => setSubject(i, { alias: e.target.value })} className="flex-1">
                    {aliasOptions(s.alias).map((a) => (
                      <option key={a} value={a}>
                        {ws.aliasLabel(a)}
                      </option>
                    ))}
                  </SelectInput>
                  <IconButton
                    icon={Trash2}
                    label={`移除人物 ${ws.aliasLabel(s.alias)}`}
                    onClick={() =>
                      setF(
                        'subjects',
                        f.subjects.filter((_, j) => j !== i),
                      )
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <MiniSelect label="画面位置" value={s.screen} options={ScreenPos.options} labels={SCREEN_POS_LABEL} onChange={(v) => setSubject(i, { screen: v })} />
                  <MiniSelect label="景深" value={s.depth} options={DepthPlane.options} labels={DEPTH_LABEL} onChange={(v) => setSubject(i, { depth: v })} />
                  <MiniSelect label="朝向" value={s.facing} options={Facing.options} labels={FACING_LABEL} onChange={(v) => setSubject(i, { facing: v })} />
                  <MiniSelect label="姿势" value={s.pose} options={Pose.options} labels={POSE_LABEL} onChange={(v) => setSubject(i, { pose: v })} />
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={characterAliases.length === 0}
                onClick={() => {
                  const used = new Set(f.subjects.map((s) => s.alias));
                  const alias = characterAliases.find((a) => !used.has(a)) ?? characterAliases[0];
                  if (alias) setF('subjects', [...f.subjects, emptySubject(alias)]);
                }}
              >
                <Plus aria-hidden className="size-3" />
                添加人物
              </Button>
              {characterAliases.length === 0 ? <span className="text-xs text-graphite-300">先在角色名单里新增角色。</span> : null}
            </div>
            <FormRow label="视点人物">
              {(id) => (
                <SelectInput id={id} value={f.pov_owner ?? ''} onChange={(e) => setF('pov_owner', e.target.value || null)}>
                  <option value="">无</option>
                  {aliasOptions(f.pov_owner ?? '').map((a) => (
                    <option key={a} value={a}>
                      {ws.aliasLabel(a)}
                    </option>
                  ))}
                </SelectInput>
              )}
            </FormRow>
          </Group>

          <Group title="画面">
            <div className="flex flex-col gap-1">
              <p className="text-xs text-graphite-300">道具与陈设</p>
              <div className="flex flex-wrap gap-1" role="group" aria-label="道具与陈设">
                {PropKind.options.map((p) => {
                  const on = f.props.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setF('props', on ? f.props.filter((x) => x !== p) : [...f.props, p])}
                      className={
                        'h-6 rounded-control border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ' +
                        (on ? 'border-graphite-100 bg-graphite-100 text-graphite-950' : 'border-graphite-700 text-graphite-300 hover:enabled:text-graphite-100')
                      }
                    >
                      {PROP_LABEL[p]}
                    </button>
                  );
                })}
              </div>
            </div>
            <EnumRow label="环境" value={f.env} options={EnvKind.options} labels={ENV_LABEL} nullLabel="未指定" onChange={(v) => setF('env', v)} />
            <EnumRow label="主体运动" value={f.subject_motion} options={SubjectMotion.options} labels={SUBJECT_MOTION_LABEL} onChange={(v) => v && setF('subject_motion', v)} />
            <label className="flex items-center gap-2 text-sm text-graphite-100">
              <input type="checkbox" checked={f.set_piece} onChange={(e) => setF('set_piece', e.target.checked)} className="size-3.5 accent-graphite-100" />
              重点段落（大动作、载具、大场面）
            </label>
          </Group>

          <Group title="内容">
            <Stacked label="叙事作用" hint="观众从这个镜头得到什么信息或情绪">
              {(id) => <TextInput id={id} value={f.narrative_purpose} onChange={(e) => setF('narrative_purpose', e.target.value)} maxLength={200} />}
            </Stacked>
            <Stacked label="动作">
              {(id) => <TextArea id={id} value={f.action} onChange={(e) => setF('action', e.target.value)} rows={3} maxLength={500} />}
            </Stacked>
            <Stacked label="台词" hint="本镜头内出现的台词原文，没有就留空">
              {(id) => <TextArea id={id} value={form.dialogue} onChange={(e) => set('dialogue', e.target.value)} rows={2} maxLength={1000} />}
            </Stacked>
            <FormRow label="时长（秒）" hint={errors.est ?? '成片中的时长，不是拍摄工时'}>
              {(id) => (
                <TextInput
                  id={id}
                  value={form.est}
                  onChange={(e) => set('est', e.target.value)}
                  inputMode="decimal"
                  className="tabular-nums"
                  aria-invalid={Boolean(errors.est) || undefined}
                />
              )}
            </FormRow>
          </Group>

          <Group title="剧本出处">
            <FormRow label="段落" hint={base ? undefined : '可以不选：手工镜头允许没有出处。'}>
              {(id) => (
                <SelectInput id={id} value={form.sourcePid} onChange={(e) => set('sourcePid', e.target.value)}>
                  {!base || form.sourcePid === '' || base.origin === 'manual' ? <option value="">不关联段落</option> : null}
                  {staleSource ? <option value={form.sourcePid}>{form.sourcePid}（不在当前场次）</option> : null}
                  {paragraphOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id} · {p.text.length > 16 ? `${p.text.slice(0, 16)}…` : p.text}
                    </option>
                  ))}
                </SelectInput>
              )}
            </FormRow>
            {chosenParagraph ? (
              <p data-paper="" className="rounded-paper bg-paper px-2.5 py-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink [color-scheme:light]">
                {chosenParagraph.text}
              </p>
            ) : null}
            {form.sourcePid ? (
              <Stacked label="引用原文" hint="从上面的段落里复制一段连续原文，用来定位和对照新版本。">
                {(id) => <TextArea id={id} value={form.sourceQuote} onChange={(e) => set('sourceQuote', e.target.value)} rows={2} maxLength={400} />}
              </Stacked>
            ) : null}
            {quoteMissing ? (
              <Notice tone="warn" title="引用与原文不一致">
                这段引用在所选段落里找不到逐字相同的原文，改版后可能被标为"待重新关联"。
              </Notice>
            ) : null}
          </Group>

          <Group title="假设与待确认问题">
            <Stacked label="假设" hint="每行一条">
              {(id) => <TextArea id={id} value={form.assumptions} onChange={(e) => set('assumptions', e.target.value)} rows={2} />}
            </Stacked>
            <Stacked label="待确认问题" hint="每行一条">
              {(id) => <TextArea id={id} value={form.questions} onChange={(e) => set('questions', e.target.value)} rows={2} />}
            </Stacked>
          </Group>

          {base ? (
            <Group title="修改说明">
              <Stacked label="说明（可选）" hint="记入修订历史">
                {(id) => <TextInput id={id} value={form.reason} onChange={(e) => set('reason', e.target.value)} maxLength={300} placeholder="例如：按勘景结果改为长焦" />}
              </Stacked>
            </Group>
          ) : (
            <Group title="手工说明">
              <Stacked label="为什么加这个镜头（必填）" error={errors.manualNote}>
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
              </Stacked>
            </Group>
          )}
        </fieldset>
      </div>

      <div className="sticky bottom-0 flex flex-col gap-2 border-t border-graphite-800 bg-graphite-900 px-3 py-2.5">
        {errors.form ? <Notice tone="danger" title={errors.form} /> : null}
        {conflict ? (
          <div className="flex flex-col gap-1.5">
            <ErrorNotice error={update.error} context="shot-save" />
            <Button size="sm" onClick={reloadLatest} disabled={!staleBase}>
              <RefreshCw aria-hidden className="size-3" />
              放弃我的修改，载入最新版本
            </Button>
          </div>
        ) : update.isError ? (
          <ErrorNotice error={update.error} context="shot-save" />
        ) : null}
        {create.isError ? <ErrorNotice error={create.error} context="shot-save" /> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" busy={pending} disabled={locked || gone || (!base && !scene) || (base !== null && !dirty)}>
            {base ? '保存' : '新建镜头'}
          </Button>
          {base ? (
            <Button variant="ghost" onClick={() => setForm(initial)} disabled={!dirty || pending}>
              还原
            </Button>
          ) : (
            <Button variant="ghost" onClick={ws.closeInspector} disabled={pending}>
              取消
            </Button>
          )}
          <span aria-live="polite" className="ml-auto text-xs text-graphite-300">
            {gone ? '镜头已归档，不能保存' : dirty ? '有未保存的修改' : savedAt ? `已保存 ${savedAt}` : ''}
          </span>
        </div>
      </div>
    </form>
  );
}
