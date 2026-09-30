import { useState, type FormEvent } from 'react';
import { addCrewRole, CREW_ROLE_MAX_LENGTH, CREW_ROLES_LIMIT, normalizeCrewRoles, roleChoices, sameCrewRoles, toggleCrewRole } from '../lib/crew.ts';
import { ErrorNotice } from './ErrorNotice.tsx';
import { Button, Field, TextInput } from './ui.tsx';

/**
 * Edit one member's crew roles (S4): preset chips to switch on and off, a
 * small field for a role of one's own, at most 6. The person themself and
 * the group's leader may open it. The parent sends the result; the checks
 * here (lib/crew.ts) only save a round trip, the server checks again.
 */
export function CrewRolesEditor({
  name,
  initial,
  busy,
  error,
  onSave,
  onCancel,
}: {
  name: string;
  initial: readonly string[];
  busy: boolean;
  error: unknown;
  onSave: (roles: string[]) => void;
  onCancel: () => void;
}) {
  const [roles, setRoles] = useState<string[]>([...initial]);
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const chosen = normalizeCrewRoles(roles);
  const unchanged = sameCrewRoles(chosen, normalizeCrewRoles(initial)) && custom.trim() === '';

  const toggle = (role: string) => {
    const next = toggleCrewRole(roles, role);
    setRoles(next.roles);
    setProblem(next.problem);
  };

  /** Adds the typed role; returns the new list, or null when it is not acceptable (the problem is shown). */
  const addCustom = (): string[] | null => {
    const next = addCrewRole(roles, custom);
    setProblem(next.problem);
    if (next.problem) return null;
    setRoles(next.roles);
    setCustom('');
    return next.roles;
  };

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    if (custom.trim() === '') return;
    addCustom();
  };

  const save = () => {
    // a role typed but not added yet still counts
    if (custom.trim() !== '') {
      const next = addCustom();
      if (next) onSave(normalizeCrewRoles(next));
      return;
    }
    onSave(chosen);
  };

  return (
    <div role="group" aria-label={`编辑 ${name} 的职务`} className="mt-2 flex flex-col gap-2.5 rounded-panel border border-graphite-700 bg-graphite-950 p-3">
      <p className="text-xs leading-5 text-graphite-300">
        点选职务，最多 {CREW_ROLES_LIMIT} 个（已选 <span className="tabular-nums">{chosen.length}</span>）；没有合适的，可以在下面写一个。
      </p>
      <ul aria-label="职务" className="flex flex-wrap gap-1">
        {roleChoices(roles).map((r) => {
          const on = roles.includes(r);
          return (
            <li key={r}>
              <button
                type="button"
                aria-pressed={on}
                disabled={busy}
                onClick={() => toggle(r)}
                className={
                  'h-6 rounded-control border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ' +
                  (on ? 'border-graphite-100 bg-graphite-100 font-medium text-graphite-950' : 'border-graphite-700 text-graphite-300 hover:enabled:border-graphite-500 hover:enabled:text-graphite-100')
                }
              >
                {r}
              </button>
            </li>
          );
        })}
      </ul>
      <form onSubmit={onAdd} noValidate className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Field label="自己写一个职务" error={problem} hint={`1–${CREW_ROLE_MAX_LENGTH} 个字，不能有空格、@ 或逗号`}>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                value={custom}
                maxLength={CREW_ROLE_MAX_LENGTH * 2}
                disabled={busy}
                onChange={(e) => {
                  setCustom(e.target.value);
                  if (problem) setProblem(null);
                }}
                placeholder="例如：副导演"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
              />
            )}
          </Field>
        </div>
        <Button type="submit" size="sm" className="mt-5" disabled={busy || custom.trim() === ''}>
          添加
        </Button>
      </form>
      {error ? <ErrorNotice error={error} context="account" /> : null}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" busy={busy} disabled={unchanged} onClick={save}>
          保存职务
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
