import { useEffect, useId, useState, type ReactNode } from 'react';
import { Emotion, Pose, TimeOfDay, type BoardArrow, type BoardSpec, type FrameFormat, type ShotFields, type Silhouette } from '@storyscript/contracts';
import { lintBoard } from '@storyscript/core';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import {
  depthBandOf,
  facing8Of,
  FACING8,
  FOCAL_MAX,
  FOCAL_MIN,
  gestureOf,
  nextGesture,
  setArrowMode,
  setAspect,
  setCameraHeight,
  setDepthBand,
  setEmotion,
  setFacing8,
  setFocal,
  setGuide143,
  setLabelText,
  setLayer,
  setOverlayOffset,
  setPitch,
  setPose,
  setRoll,
  setSilhouette,
  setTimeOfDay,
  setTone,
  type DepthBand,
  type Facing8,
} from '../../lib/board-editor.ts';
import {
  ARROW_KIND_LABEL,
  ARROW_MODE_LABEL,
  ASPECTS,
  DEPTH_BAND_LABEL,
  FACING8_LABEL,
  LAYER_OPTIONS,
  SILHOUETTE_LABEL,
  TONE_OPTIONS,
} from '../../lib/labels-boards.ts';
import { EMOTION_LABEL, FRAME_FORMAT_LABEL, POSE_LABEL, TIME_OF_DAY_LABEL } from '../../lib/labels.ts';
import { CommentsPanel } from '../../components/CommentsPanel.tsx';
import { Button, SelectInput, TextInput } from '../../components/ui.tsx';
import { Inspector, InspectorGroup, InspectorRow } from '../../components/workspace.tsx';
import { useIsHosted } from '../../lib/queries-comments.ts';
import type { EditorApi } from './useEditor.ts';

/**
 * Right-hand inspector of the board page: everything that is not dragged on
 * the canvas. Person (facing, pose, 换个动作 for the pose's gesture variants,
 * depth, tone, silhouette, layer), camera
 * (focal with "keep shot size", height, tilt, roll, aspect, 1.43 guide) and
 * annotations (label text, arrow mode, whole-layer offset). Sliders preview
 * while dragged (the canvas shows structure) and commit one undo step on
 * release. On the hosted server the shot's 批注 (S4b) close the list: new
 * ones are about the version being edited, 本版 / 全部 filters the threads.
 */

const POSES = Pose.options;
const SILHOUETTES = Object.keys(SILHOUETTE_LABEL) as Silhouette[];
const BANDS: DepthBand[] = ['fg', 'mg', 'bg'];

function optValue(v: number | null): string {
  return v === null ? 'auto' : String(v);
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onPreview,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  disabled: boolean;
  onPreview: (v: number) => void;
  onCommit: () => void;
}) {
  const id = useId();
  return (
    <>
      <dt className="text-xs leading-5 text-graphite-300">
        <label htmlFor={id}>{label}</label>
      </dt>
      <dd className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onPreview(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          onBlur={onCommit}
          className="h-5 min-w-0 flex-1 accent-graphite-100 disabled:opacity-50"
        />
        <output htmlFor={id} className="w-14 shrink-0 text-right text-xs text-graphite-100 tabular-nums">
          {format(value)}
        </output>
      </dd>
    </>
  );
}

function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <label className={`flex items-center gap-2 text-sm text-graphite-100 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" className="size-3.5 shrink-0 accent-graphite-100" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Label text: typed freely, committed as one undo step on blur / Enter. */
function LabelField({ id, text, disabled, onCommit }: { id: string; text: string; disabled: boolean; onCommit: (t: string) => void }) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <TextInput
      aria-label={`标签文字（${id}）`}
      value={draft}
      disabled={disabled}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== text && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (draft !== text) onCommit(draft);
        } else if (e.key === 'Escape') setDraft(text);
      }}
    />
  );
}

export interface BoardInspectorProps {
  editor: EditorApi;
  readOnly: boolean;
  fields: ShotFields | undefined;
  keepSize: boolean;
  onKeepSize: (v: boolean) => void;
  sceneSides: { left: string | null; right: string | null } | null;
  /** an older version being viewed (read-only): its values are shown */
  viewSpec?: BoardSpec | null;
}

export function BoardInspector({ editor, readOnly, fields, keepSize, onKeepSize, sceneSides, viewSpec }: BoardInspectorProps) {
  const hosted = useIsHosted();
  const spec = viewSpec ?? editor.spec;
  const present = editor.present;
  const subjects = spec.scene.subjects;
  const selectedSubject = editor.selection?.kind === 'subject' ? subjects.find((s) => s.id === editor.selection?.id) : undefined;
  const subject = selectedSubject ?? subjects[0];
  const cam = spec.camera;

  const commit = (label: string, fn: (s: BoardSpec) => BoardSpec) => editor.commit(label, fn(present));
  const slide = (fn: (s: BoardSpec) => BoardSpec) => editor.preview(fn(present));
  // no-op unless a slider drag is being previewed
  const end = (label: string) => () => editor.endPreview(label);

  const facing = subject ? facing8Of(spec, subject.id) : null;
  const gesture = subject ? gestureOf(spec, subject.id) : null;
  const band = subject ? depthBandOf(spec, subject.id) : null;
  const issues = fields ? lintBoard(spec, fields, { scene_sides: sceneSides }) : [];
  const off = spec.overlay.offset;

  return (
    <Inspector>
      <InspectorGroup
        title="人物"
        note={
          subjects.length === 0 ? (
            <p className="text-graphite-300">这一格没有人物。</p>
          ) : readOnly ? null : (
            <p className="text-xs text-graphite-300">在画面上拖动脚下的椭圆移动人物；方向键微调。</p>
          )
        }
      >
        {subject ? (
          <>
            <InspectorRow label="人物">
              <SelectInput
                aria-label="选择人物"
                value={subject.id}
                onChange={(e) => editor.select({ kind: 'subject', id: e.target.value })}
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.badge} · {s.label}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
            <InspectorRow label="朝向">
              <SelectInput
                aria-label="朝向"
                disabled={readOnly}
                value={facing === null ? '' : String(facing)}
                onChange={(e) => commit('改朝向', (s) => setFacing8(s, subject.id, Number(e.target.value) as Facing8))}
              >
                {FACING8.map((f) => (
                  <option key={f} value={String(f)}>
                    {FACING8_LABEL[f]}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
            <InspectorRow label="姿势">
              <SelectInput aria-label="姿势" disabled={readOnly} value={subject.pose} onChange={(e) => commit('改姿势', (s) => setPose(s, subject.id, e.target.value as Pose))}>
                {POSES.map((p) => (
                  <option key={p} value={p}>
                    {POSE_LABEL[p]}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
            <InspectorRow label="情绪">
              <SelectInput
                aria-label="情绪"
                disabled={readOnly}
                value={subject.emotion ?? 'neutral'}
                onChange={(e) => commit('改情绪', (s) => setEmotion(s, subject.id, e.target.value as Emotion))}
              >
                {Emotion.options.map((x) => (
                  <option key={x} value={x}>
                    {EMOTION_LABEL[x]}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
            {gesture && subject ? (
              <InspectorRow label="手势">
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={readOnly} onClick={() => commit('换个动作', (s) => nextGesture(s, subject.id))} title="在这个姿势的几种手势里换下一种（插兜、抱臂、叉腰……）">
                    换个动作
                  </Button>
                  <span className="text-xs text-graphite-300 tabular-nums" aria-label={`第 ${gesture.index + 1} 种，共 ${gesture.count} 种`}>
                    {gesture.index + 1} / {gesture.count}
                  </span>
                </div>
              </InspectorRow>
            ) : null}
            <InspectorRow label="景深">
              <SelectInput
                aria-label="景深"
                disabled={readOnly}
                value={band ?? 'mg'}
                onChange={(e) => commit('改景深', (s) => setDepthBand(s, subject.id, e.target.value as DepthBand))}
              >
                {BANDS.map((b) => (
                  <option key={b} value={b}>
                    {DEPTH_BAND_LABEL[b]}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
            <InspectorRow label="明暗">
              <SelectInput
                aria-label="明暗"
                disabled={readOnly}
                value={optValue(subject.tone_override)}
                onChange={(e) => commit('改明暗', (s) => setTone(s, subject.id, e.target.value === 'auto' ? null : Number(e.target.value)))}
              >
                {TONE_OPTIONS.map((o) => (
                  <option key={optValue(o.value)} value={optValue(o.value)}>
                    {o.label}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
            <InspectorRow label="轮廓">
              <SelectInput
                aria-label="轮廓"
                disabled={readOnly}
                value={subject.silhouette}
                onChange={(e) => commit('改轮廓', (s) => setSilhouette(s, subject.id, e.target.value as Silhouette))}
              >
                {SILHOUETTES.map((v) => (
                  <option key={v} value={v}>
                    {SILHOUETTE_LABEL[v]}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
            <InspectorRow label="层级">
              <SelectInput
                aria-label="层级覆盖"
                disabled={readOnly}
                value={optValue(subject.z_override)}
                onChange={(e) => commit('改层级', (s) => setLayer(s, subject.id, e.target.value === 'auto' ? null : Number(e.target.value)))}
              >
                {LAYER_OPTIONS.map((o) => (
                  <option key={optValue(o.value)} value={optValue(o.value)}>
                    {o.label}
                  </option>
                ))}
              </SelectInput>
            </InspectorRow>
          </>
        ) : null}
      </InspectorGroup>

      <InspectorGroup
        title="相机"
        note={
          <Check checked={keepSize} onChange={onKeepSize} disabled={readOnly}>
            焦段变化时保持景别
          </Check>
        }
      >
        <SliderRow
          label="焦段"
          value={cam.focal_mm}
          min={FOCAL_MIN}
          max={FOCAL_MAX}
          step={1}
          format={(v) => `${Math.round(v)}mm`}
          disabled={readOnly}
          onPreview={(v) => slide((s) => setFocal(s, v, { keepSize, fields: fields ?? null }))}
          onCommit={end(keepSize ? '改焦段（保持景别）' : '改焦段')}
        />
        <SliderRow
          label="机高"
          value={cam.y}
          min={0.1}
          max={8}
          step={0.05}
          format={(v) => `${v.toFixed(2)} m`}
          disabled={readOnly}
          onPreview={(v) => slide((s) => setCameraHeight(s, v))}
          onCommit={end('改机高')}
        />
        <SliderRow
          label="俯仰"
          value={cam.pitch_deg}
          min={-90}
          max={90}
          step={0.5}
          format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`}
          disabled={readOnly}
          onPreview={(v) => slide((s) => setPitch(s, v))}
          onCommit={end('改俯仰')}
        />
        <SliderRow
          label="横滚"
          value={cam.roll_deg}
          min={-45}
          max={45}
          step={0.5}
          format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`}
          disabled={readOnly}
          onPreview={(v) => slide((s) => setRoll(s, v))}
          onCommit={end('改横滚')}
        />
        <InspectorRow label="画幅">
          <SelectInput aria-label="画幅" disabled={readOnly} value={spec.frame.aspect} onChange={(e) => commit('改画幅', (s) => setAspect(s, e.target.value as FrameFormat))}>
            {ASPECTS.map((a) => (
              <option key={a} value={a}>
                {FRAME_FORMAT_LABEL[a]}
              </option>
            ))}
          </SelectInput>
        </InspectorRow>
        <InspectorRow label="保护线">
          <Check
            checked={spec.frame.guides.includes('1.43')}
            disabled={readOnly || spec.frame.aspect === '1.43'}
            onChange={(v) => commit(v ? '显示 1.43 保护线' : '隐藏 1.43 保护线', (s) => setGuide143(s, v))}
          >
            1.43 中心保护线
          </Check>
        </InspectorRow>
        <InspectorRow label="时段">
          <SelectInput aria-label="时段" disabled={readOnly} value={spec.scene.time ?? 'day'} onChange={(e) => commit('改时段', (s) => setTimeOfDay(s, e.target.value as TimeOfDay))}>
            {TimeOfDay.options.map((t) => (
              <option key={t} value={t}>
                {TIME_OF_DAY_LABEL[t]}
              </option>
            ))}
          </SelectInput>
        </InspectorRow>
      </InspectorGroup>

      <InspectorGroup title="标注" note={spec.overlay.arrows.length ? <p className="text-xs text-graphite-300">拖动箭头两端的小方块改端点。</p> : null}>
        {spec.overlay.labels.map((l) => (
          <InspectorRow key={l.id} label={l.prop_id ? '物件名称' : '标签'}>
            <LabelField id={l.id} text={l.text} disabled={readOnly} onCommit={(t) => commit('改标签文字', (s) => setLabelText(s, l.id, t))} />
          </InspectorRow>
        ))}
        {spec.overlay.arrows.map((a) => (
          <InspectorRow key={a.id} label={ARROW_KIND_LABEL[a.kind]}>
            <SelectInput
              aria-label={`${ARROW_KIND_LABEL[a.kind]}箭头（${a.id}）的模式`}
              disabled={readOnly}
              value={a.mode}
              onFocus={() => editor.select({ kind: 'arrow', id: a.id })}
              onChange={(e) => commit('改箭头模式', (s) => setArrowMode(s, a.id, e.target.value as BoardArrow['mode']))}
              className={editor.selection?.kind === 'arrow' && editor.selection.id === a.id ? 'border-graphite-300' : ''}
            >
              {(Object.keys(ARROW_MODE_LABEL) as BoardArrow['mode'][]).map((m) => (
                <option key={m} value={m}>
                  {ARROW_MODE_LABEL[m]}
                </option>
              ))}
            </SelectInput>
          </InspectorRow>
        ))}
        <SliderRow
          label="整层左右"
          value={off.x}
          min={-0.2}
          max={0.2}
          step={0.005}
          format={(v) => `${Math.round(v * 1000) / 10}%`}
          disabled={readOnly}
          onPreview={(v) => slide((s) => setOverlayOffset(s, v, s.overlay.offset.y))}
          onCommit={end('平移标注层')}
        />
        <SliderRow
          label="整层上下"
          value={off.y}
          min={-0.2}
          max={0.2}
          step={0.005}
          format={(v) => `${Math.round(v * 1000) / 10}%`}
          disabled={readOnly}
          onPreview={(v) => slide((s) => setOverlayOffset(s, s.overlay.offset.x, v))}
          onCommit={end('平移标注层')}
        />
        {off.x !== 0 || off.y !== 0 ? (
          <InspectorRow label="">
            <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => commit('标注层归位', (s) => setOverlayOffset(s, 0, 0))}>
              标注层归位
            </Button>
          </InspectorRow>
        ) : null}
      </InspectorGroup>

      <InspectorGroup
        title="构图检查"
        note={
          issues.length === 0 ? (
            <p className="text-xs text-graphite-300">{fields ? '没有发现问题。' : '镜头信息未载入。'}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {issues.map((i, n) => (
                <li key={`${i.code}-${n}`} className="flex items-start gap-1.5 text-xs text-graphite-100">
                  {i.level === 'error' ? (
                    <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-danger" />
                  ) : (
                    <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-warn" />
                  )}
                  <span>{i.message}</span>
                </li>
              ))}
            </ul>
          )
        }
      />

      {hosted ? <CommentsPanel key={editor.base.shot_id} shotId={editor.base.shot_id} board={{ id: editor.base.id, version: editor.base.version }} /> : null}
    </Inspector>
  );
}
