import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Scene, Shot, StyleLevel } from '@storyscript/contracts';
import { TECHNIQUES } from '@storyscript/core';
import { FileSearch, LocateFixed, Palette, Sparkles } from 'lucide-react';
import { breakdownSlot, JOB_STATUS_LABEL, trackJob, useTrackedJob } from '../../lib/jobs.ts';
import { useJob, useRequestBreakdown, useUpdateScene } from '../../lib/queries.ts';
import { useStyles } from '../../lib/queries-style.ts';
import { pageHref } from '../../lib/stages.ts';
import { effectiveLevel, effectiveStyleId, outgoingSentence } from '../../lib/style-form.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, SelectInput, TextArea, TextInput } from '../../components/ui.tsx';
import { Inspector, InspectorGroup, InspectorRow } from '../../components/workspace.tsx';
import { useWorkspace } from './context.ts';
import { LevelRow, StyleSelectRow } from './StyleControls.tsx';

/** 风格要求: free text the model gets as data (contract limit 800). */
const STYLE_NOTE_MAX = 800;

/** A labelled control row in the inspector's label/value grid (label wired to the control). */
export function FormRow({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5">
      <label htmlFor={id} className="text-xs leading-5 text-graphite-300">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="col-start-2 text-xs text-graphite-300">{hint}</p> : null}
    </div>
  );
}

const groupId = (sceneId: string, focus: 'breakdown' | 'setup') => `inspector-${focus}-${sceneId}`;

// ----------------------------------------------------------- screen sides --

function SetupGroup({ scene }: { scene: Scene }) {
  const ws = useWorkspace();
  const update = useUpdateScene();
  const left = scene.screen_sides?.left ?? '';
  const right = scene.screen_sides?.right ?? '';

  const setSides = (l: string, r: string) =>
    update.mutate({ id: scene.id, input: { screen_sides: l === '' && r === '' ? null : { left: l || null, right: r || null } } });

  const aliasOpts = (current: string) => {
    const list = ws.characters.map((c) => c.alias);
    return current && !list.includes(current) ? [current, ...list] : list;
  };

  return (
    <div id={groupId(scene.id, 'setup')} className="scroll-mt-2">
      <InspectorGroup
        title="站位与地点"
        note={
          <div className="flex flex-col gap-2">
            <p className="text-xs text-graphite-300">左右站位用于过肩镜头和越轴检查。</p>
            {ws.characters.length === 0 ? (
              <p className="text-xs text-graphite-300">角色名单为空：先在"角色 · 地点 · 道具"里添加角色。</p>
            ) : null}
            <FormRow label="画左">
              {(id) => (
                <SelectInput id={id} value={left} onChange={(e) => setSides(e.target.value, right)} disabled={update.isPending || ws.characters.length === 0}>
                  <option value="">未指定</option>
                  {aliasOpts(left).map((a) => (
                    <option key={a} value={a}>
                      {ws.aliasLabel(a)}
                    </option>
                  ))}
                </SelectInput>
              )}
            </FormRow>
            <FormRow label="画右">
              {(id) => (
                <SelectInput id={id} value={right} onChange={(e) => setSides(left, e.target.value)} disabled={update.isPending || ws.characters.length === 0}>
                  <option value="">未指定</option>
                  {aliasOpts(right).map((a) => (
                    <option key={a} value={a}>
                      {ws.aliasLabel(a)}
                    </option>
                  ))}
                </SelectInput>
              )}
            </FormRow>
            <FormRow label="地点" hint={ws.locations.length === 0 ? '名单里还没有地点。' : undefined}>
              {(id) => (
                <SelectInput
                  id={id}
                  value={scene.location_entity_id ?? ''}
                  onChange={(e) => update.mutate({ id: scene.id, input: { location_entity_id: e.target.value || null } })}
                  disabled={update.isPending || ws.locations.length === 0}
                >
                  <option value="">未指定</option>
                  {ws.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.alias} {l.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            </FormRow>
            {update.isError ? <ErrorNotice error={update.error} /> : null}
          </div>
        }
      />
    </div>
  );
}

// ------------------------------------------------------- AI breakdown form --

function BreakdownGroup({ scene, shots, autoFocus }: { scene: Scene; shots: readonly Shot[]; autoFocus: boolean }) {
  const ws = useWorkspace();
  const request = useRequestBreakdown();
  const tracked = useTrackedJob(breakdownSlot(scene.id));
  const trackedJob = useJob(tracked?.jobId ?? null);
  const styles = useStyles();
  const [technique, setTechnique] = useState('');
  const [reference, setReference] = useState('');
  // null = not touched: the form follows the group's defaults once they load
  const [styleChoice, setStyleChoice] = useState<string | null>(null);
  const [levelChoice, setLevelChoice] = useState<StyleLevel | null>(null);
  const [maxShots, setMaxShots] = useState('12');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refId = useId();
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (autoFocus) form.current?.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true });
  }, [autoFocus]);

  const chosen = TECHNIQUES.find((t) => t.id === technique) ?? null;
  const styleId = effectiveStyleId(styleChoice, styles.data);
  const level = effectiveLevel(levelChoice, styles.data);
  const chosenStyle = styles.data?.cards.find((c) => c.id === styleId) ?? null;
  const locked = shots.filter((s) => s.locked).length;
  const pendingDraft = ws.pendingDraftByScene.get(scene.id) ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const max = Number(maxShots);
    const secs = target.trim() === '' ? null : Number(target);
    if (!Number.isInteger(max) || max < 1 || max > 40) return setError('镜头上限需要是 1 到 40 之间的整数');
    if (secs !== null && (!Number.isInteger(secs) || secs <= 0)) return setError('目标时长需要是正整数（秒），或者留空');
    setError(null);
    request.mutate(
      {
        sceneId: scene.id,
        input: {
          technique_id: technique || null,
          reference_note: reference.trim() || null,
          max_shots: max,
          target_seconds: secs,
          style_id: styleId || null,
          level,
        },
      },
      {
        onSuccess: ({ job_id }) => {
          trackJob(breakdownSlot(scene.id), job_id);
          if (!ws.wide) ws.closeInspector();
        },
      },
    );
  };

  let body: ReactNode;
  if (!ws.ai.enabled) {
    body = (
      <p className="text-xs text-graphite-300">
        {ws.ai.reason}{' '}
        <a href={pageHref('settings')} className="text-graphite-100 underline underline-offset-2">
          前往设置
        </a>
      </p>
    );
  } else {
    body = (
      <form ref={form} onSubmit={submit} className="flex flex-col gap-2" noValidate>
        <FormRow label="手法" hint={chosen ? chosen.intended_effect : '不指定时，由模型按场面从手法库中选择。'}>
          {(id) => (
            <SelectInput id={id} value={technique} onChange={(e) => setTechnique(e.target.value)}>
              <option value="">不指定</option>
              {TECHNIQUES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectInput>
          )}
        </FormRow>
        <StyleSelectRow cards={styles.data?.cards ?? []} value={styleId} onChange={setStyleChoice} hint={chosenStyle ? undefined : '不指定时，按剧本和上面的手法来拆。'} />
        <LevelRow value={level} onChange={setLevelChoice} />
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={ws.openStyles}>
            <Palette aria-hidden className="size-3" />
            管理风格…
          </Button>
        </div>
        {styles.isError ? <ErrorNotice error={styles.error} /> : null}
        <div className="flex flex-col gap-1">
          <label htmlFor={refId} className="text-xs text-graphite-300">
            风格要求
          </label>
          <TextArea
            id={refId}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            rows={3}
            maxLength={STYLE_NOTE_MAX}
            placeholder="例如：节奏克制，多用静止的近景"
          />
          <p className="text-xs text-graphite-300">
            作为数据发给模型，输出为通用手法建议（未核实），不会引用具体影片的镜头。
            <span className="tabular-nums">
              {reference.length}/{STYLE_NOTE_MAX}
            </span>
          </p>
        </div>
        <FormRow label="镜头上限">
          {(id) => <TextInput id={id} value={maxShots} onChange={(e) => setMaxShots(e.target.value)} inputMode="numeric" className="tabular-nums" />}
        </FormRow>
        <FormRow label="目标时长">
          {(id) => (
            <TextInput id={id} value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" placeholder="秒，可不填" className="tabular-nums" />
          )}
        </FormRow>
        <p className="text-xs text-graphite-300">
          {outgoingSentence({ paragraphs: scene.paragraph_ids.length, characters: ws.characters.length, styleName: chosenStyle?.name ?? null, hasStyleNote: reference.trim() !== '' })}{' '}
          <span className="text-graphite-100">{ws.providerHost ?? '你配置的地址'}</span>。结果先进草案，勾选后才写入镜头表；每步最多外发 3 次。
          {locked > 0 ? ` 本场 ${locked} 个锁定镜头不会被改动。` : shots.length > 0 ? ' 要保护的镜头可以先锁定。' : ''}
        </p>
        {ws.characters.length === 0 ? (
          <Notice tone="warn" title="角色名单为空">
            模型只能用名单里的角色编号指代人物。先在左侧添加或抽取角色，否则含人物的镜头都会带错误。
          </Notice>
        ) : null}
        {error ? <Notice tone="danger" title={error} /> : null}
        {request.isError ? <ErrorNotice error={request.error} context="ai-request" /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={request.isPending} disabled={tracked !== null}>
            {request.isPending ? null : <Sparkles aria-hidden className="size-3.5" />}
            开始拆镜
          </Button>
          {tracked ? (
            <span className="text-xs text-graphite-300" role="status">
              {trackedJob.data ? `任务${JOB_STATUS_LABEL[trackedJob.data.status]}` : '任务已提交'}，进度见镜头表。
            </span>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <div id={groupId(scene.id, 'breakdown')} className="scroll-mt-2">
      <InspectorGroup
        title="AI 拆镜"
        actions={
          pendingDraft ? (
            <Button size="sm" onClick={() => ws.openDraft(pendingDraft.id)}>
              <FileSearch aria-hidden className="size-3" />
              审阅草案
            </Button>
          ) : undefined
        }
        note={body}
      />
    </div>
  );
}

// ------------------------------------------------------------------ scene --

export function SceneInspector({ scene, shots, focus }: { scene: Scene; shots: readonly Shot[]; focus?: 'breakdown' | 'setup' }) {
  const ws = useWorkspace();
  const heading = scene.paragraph_ids[0];
  const seconds = shots.filter((s) => s.required_status !== 'waived').reduce((sum, s) => sum + (Number.isFinite(s.fields.est_seconds) ? s.fields.est_seconds : 0), 0);
  const relink = shots.filter((s) => s.needs_relink).length;

  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(groupId(scene.id, focus));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, [focus, scene.id]);

  return (
    <Inspector>
      <InspectorGroup
        title="概况"
        actions={
          heading ? (
            <Button variant="ghost" size="sm" onClick={() => ws.locate({ paragraph_id: heading, quote: '' })} title="在剧本原文中定位本场">
              <LocateFixed aria-hidden className="size-3" />
              定位原文
            </Button>
          ) : undefined
        }
      >
        <InspectorRow label="标题">{scene.heading}</InspectorRow>
        <InspectorRow label="时间">{scene.time_label ?? <span className="text-graphite-300">未识别</span>}</InspectorRow>
        <InspectorRow label="段落">
          <span className="tabular-nums">{scene.paragraph_ids.length} 段</span>
        </InspectorRow>
        <InspectorRow label="镜头">
          <span className="tabular-nums">
            {shots.length} 镜{seconds > 0 ? ` · 约 ${Math.round(seconds)} 秒` : ''}
            {relink > 0 ? ` · ${relink} 个待重新关联` : ''}
          </span>
        </InspectorRow>
      </InspectorGroup>
      <SetupGroup scene={scene} />
      <BreakdownGroup key={scene.id} scene={scene} shots={shots} autoFocus={focus === 'breakdown'} />
    </Inspector>
  );
}
