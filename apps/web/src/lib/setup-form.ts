import type { Setup, SetupDurations } from '@storyscript/contracts';

/**
 * S4a — the text part of the plan page's setup editor: the name and the three
 * durations, kept as the strings being typed. Selects and checkboxes commit at
 * once and are not part of it. Pure (no DOM, no React); useRebasedForm follows
 * the server's value of this part and keeps the person's typing.
 */

export type DurKey = keyof SetupDurations;

export const DUR_KEYS: readonly DurKey[] = ['setup_min', 'per_shot_min', 'reset_min'];

export interface SetupForm {
  label: string;
  setup_min: string;
  per_shot_min: string;
  reset_min: string;
}

/** The form's part of a setup. */
export function setupForm(s: Pick<Setup, 'label' | 'durations'>): SetupForm {
  return {
    label: s.label,
    setup_min: String(s.durations.setup_min),
    per_shot_min: String(s.durations.per_shot_min),
    reset_min: String(s.durations.reset_min),
  };
}

export interface SetupCommit {
  /** what to send (without expected_revision); null when nothing changed */
  input: { label?: string; durations?: SetupDurations } | null;
  /** the draft after the check: trimmed name, tidy numbers; an invalid entry goes back to what it was */
  draft: SetupForm;
}

/**
 * The name or a duration was committed (blur or Enter): what changed against
 * the value the form started from.
 *  - an empty name goes back to the old one;
 *  - a duration that is empty, not a number or negative goes back to the old
 *    one, and no duration is sent this time (as before S4a).
 */
export function setupCommit(seed: SetupForm, draft: SetupForm): SetupCommit {
  const fixed: SetupForm = { ...draft };
  const input: NonNullable<SetupCommit['input']> = {};

  const label = draft.label.trim();
  if (label === '') fixed.label = seed.label;
  else {
    fixed.label = label;
    if (label !== seed.label) input.label = label;
  }

  let invalid = false;
  const next: Partial<SetupDurations> = {};
  for (const k of DUR_KEYS) {
    const n = Number(draft[k]);
    if (draft[k].trim() === '' || !Number.isFinite(n) || n < 0) {
      fixed[k] = seed[k];
      invalid = true;
    } else {
      next[k] = n;
      fixed[k] = String(n);
    }
  }
  if (!invalid && DUR_KEYS.some((k) => next[k] !== Number(seed[k]))) input.durations = next as SetupDurations;

  return { input: Object.keys(input).length > 0 ? input : null, draft: fixed };
}
