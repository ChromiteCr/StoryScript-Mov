import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { STYLE_LIMITS, type StyleCard, type StyleCardInput } from '@storyscript/contracts';
import { biasSummary, BIAS_GROUPS, hasFormErrors, normalizeStyleForm, toggleBias, validateStyleForm } from '../../lib/style-form.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Field, Tag, TextArea, TextInput } from '../../components/ui.tsx';

/**
 * The style card's fields, as a form (new card, edit, or the reviewed result
 * of a style research) and as read-only details.
 */

const counter = (n: number, max: number) => (
  <span className="tabular-nums">
    {n}/{max}
  </span>
);

function BiasPicker({ value, onChange }: { value: StyleCardInput['bias']; onChange: (bias: StyleCardInput['bias']) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-graphite-300">偏好（可多选，不选表示不限）</legend>
      {BIAS_GROUPS.map((g) => (
        <div key={g.key} role="group" aria-label={`偏好${g.label}`} className="flex flex-wrap items-center gap-1">
          <span aria-hidden className="w-9 shrink-0 text-xs text-graphite-300">
            {g.label}
          </span>
          {g.options.map((o) => {
            const on = (value[g.key] as readonly string[]).includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(toggleBias(value, g.key, o))}
                className={
                  'h-6 rounded-control border px-2 text-xs ' +
                  (on ? 'border-graphite-100 bg-graphite-100 text-graphite-950' : 'border-graphite-700 text-graphite-300 hover:text-graphite-100')
                }
              >
                {g.labels[o] ?? o}
              </button>
            );
          })}
        </div>
      ))}
    </fieldset>
  );
}

export interface StyleCardFormProps {
  /** the form's accessible name, e.g. "新建风格卡" */
  label: string;
  initial: StyleCardInput;
  submitLabel: string;
  busy?: boolean;
  error?: unknown;
  onSubmit: (input: StyleCardInput) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  /** more buttons after the cancel button */
  extraActions?: ReactNode;
  /** move focus to the first field when the form appears (new card, edit) */
  autoFocus?: boolean;
}

export function StyleCardForm({ label, initial, submitLabel, busy = false, error, onSubmit, onCancel, cancelLabel = '取消', extraActions, autoFocus = false }: StyleCardFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (autoFocus) formRef.current?.querySelector('input')?.focus();
  }, [autoFocus]);
  const [form, setForm] = useState<StyleCardInput>(initial);
  const [submitted, setSubmitted] = useState(false);
  const errors = submitted ? validateStyleForm(form) : {};
  const set = <K extends keyof StyleCardInput>(key: K, value: StyleCardInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (hasFormErrors(validateStyleForm(form))) return;
    onSubmit(normalizeStyleForm(form));
  };

  return (
    <form ref={formRef} aria-label={label} onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-panel border border-graphite-700 bg-graphite-950/40 p-3">
      <Field label="名称" error={errors.name} hint="用手法命名，不写人名和片名。">
        {({ id, describedBy, invalid }) => (
          <TextInput id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={form.name} maxLength={STYLE_LIMITS.name} onChange={(e) => set('name', e.target.value)} />
        )}
      </Field>
      <Field label="一句话概括" error={errors.summary}>
        {({ id, describedBy, invalid }) => (
          <TextInput id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={form.summary} maxLength={STYLE_LIMITS.summary} onChange={(e) => set('summary', e.target.value)} />
        )}
      </Field>
      <Field label="镜头语言" error={errors.grammar} hint={<>运镜、镜头、构图和节奏，一条一行。{counter(form.grammar.length, STYLE_LIMITS.grammar)}</>}>
        {({ id, describedBy, invalid }) => (
          <TextArea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={form.grammar} rows={7} maxLength={STYLE_LIMITS.grammar} onChange={(e) => set('grammar', e.target.value)} />
        )}
      </Field>
      <BiasPicker value={form.bias} onChange={(bias) => set('bias', bias)} />
      <Field label="器材与人手" error={errors.gear} hint={counter(form.gear.length, STYLE_LIMITS.gear)}>
        {({ id, describedBy, invalid }) => (
          <TextArea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={form.gear} rows={2} maxLength={STYLE_LIMITS.gear} onChange={(e) => set('gear', e.target.value)} />
        )}
      </Field>
      <Field label="低成本替代" error={errors.low_budget} hint={counter(form.low_budget.length, STYLE_LIMITS.low_budget)}>
        {({ id, describedBy, invalid }) => (
          <TextArea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={form.low_budget} rows={2} maxLength={STYLE_LIMITS.low_budget} onChange={(e) => set('low_budget', e.target.value)} />
        )}
      </Field>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
        ) : null}
        {extraActions}
      </div>
    </form>
  );
}

/** Read-only view of a card's body: camera language, preferences, gear, low-budget substitute. */
export function StyleCardDetails({ card }: { card: Pick<StyleCard, 'grammar' | 'bias' | 'gear' | 'low_budget'> }) {
  const bias = biasSummary(card.bias);
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <p className="text-xs text-graphite-300">镜头语言</p>
        <p className="mt-0.5 text-sm leading-6 whitespace-pre-wrap text-graphite-100">{card.grammar}</p>
      </div>
      {bias.length > 0 ? (
        <div>
          <p className="text-xs text-graphite-300">偏好</p>
          <div className="mt-1 flex flex-col gap-1">
            {bias.map((g) => (
              <div key={g.key} className="flex flex-wrap items-center gap-1">
                <span className="w-9 shrink-0 text-xs text-graphite-300">{g.label}</span>
                {g.values.map((v) => (
                  <Tag key={v}>{v}</Tag>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {card.gear ? (
        <div>
          <p className="text-xs text-graphite-300">器材与人手</p>
          <p className="mt-0.5 text-sm leading-6 whitespace-pre-wrap text-graphite-100">{card.gear}</p>
        </div>
      ) : null}
      {card.low_budget ? (
        <div>
          <p className="text-xs text-graphite-300">低成本替代</p>
          <p className="mt-0.5 text-sm leading-6 whitespace-pre-wrap text-graphite-100">{card.low_budget}</p>
        </div>
      ) : null}
    </div>
  );
}
