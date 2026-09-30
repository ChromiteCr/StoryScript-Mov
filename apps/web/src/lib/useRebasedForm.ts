import { useCallback, useState } from 'react';
import { stableKey } from './stable.ts';

/**
 * S4a — a form whose starting point can move under it (a teammate saved the
 * same thing) without the person's typing being lost.
 *
 * The form keeps four things: the `draft` being edited, the `seed` it started
 * from (the server's value when editing began, or the last value the person
 * saved), the `base` revision to send as expected_revision, and the `latest`
 * value the server has shown since. The rules (rebasedReduce, pure and tested):
 *
 *  - the server value changes while the draft is still the seed: follow it
 *    silently (draft, seed and revision all move);
 *  - it changes while the draft has edits: the draft stays; if the change
 *    touches what the form holds, a conflict is offered, 「用他的｜保留我的」;
 *  - the server value equals the draft (the person's own save came back): clean;
 *  - only the revision moved (the teammate changed something the form does
 *    not hold): the base revision follows, so saving is not refused for it;
 *  - 用他的: draft and seed become the server's value;
 *    保留我的: the fields the person changed stay theirs, fields they did not
 *    touch follow the teammate (rebaseOntoLatest), and the base moves to the
 *    server's revision, so the next save wins only where the person chose;
 *  - a save that succeeded: acknowledge it with the value and revision the
 *    server returned (a pending conflict is not swallowed by it).
 */

export interface RebasedState<T> {
  draft: T;
  seed: T;
  /** the revision to send as expected_revision; undefined when the server has none */
  base: number | undefined;
  latest: T;
  latestRevision: number | undefined;
}

export type RebasedAction<T> =
  | { type: 'server'; value: T; revision: number | undefined }
  | { type: 'edit'; draft: T }
  | { type: 'theirs' }
  | { type: 'mine' }
  | { type: 'acknowledge'; value: T; revision: number | undefined }
  | { type: 'reset'; value: T; revision: number | undefined };

export type Equals<T> = (a: T, b: T) => boolean;

export const sameValue = <T>(a: T, b: T): boolean => stableKey(a) === stableKey(b);

export function rebasedInit<T>(value: T, revision: number | undefined): RebasedState<T> {
  return { draft: value, seed: value, base: revision, latest: value, latestRevision: revision };
}

/** Edits the person has made: the draft differs from what it started from. */
export function isDirty<T>(s: RebasedState<T>, equals: Equals<T> = sameValue): boolean {
  return !equals(s.draft, s.seed);
}

/** A teammate's change that the person's edits are in the way of. */
export function hasConflict<T>(s: RebasedState<T>, equals: Equals<T> = sameValue): boolean {
  return isDirty(s, equals) && !equals(s.latest, s.seed);
}

/**
 * 保留我的 for a flat record: keep the fields the person changed (draft ≠ seed),
 * take the teammate's value for every field they left alone. Non-records keep
 * the draft whole.
 */
export function rebaseOntoLatest<T>(draft: T, seed: T, latest: T): T {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return draft;
  if (typeof latest !== 'object' || latest === null || Array.isArray(latest)) return draft;
  const d = draft as Record<string, unknown>;
  const sd = (seed ?? {}) as Record<string, unknown>;
  const l = latest as Record<string, unknown>;
  const out: Record<string, unknown> = { ...d };
  for (const k of Object.keys(l)) if (sameValue(d[k], sd[k])) out[k] = l[k];
  return out as T;
}

function newer(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || a >= b;
}

export function rebasedReduce<T>(s: RebasedState<T>, a: RebasedAction<T>, equals: Equals<T> = sameValue): RebasedState<T> {
  switch (a.type) {
    case 'edit':
      return { ...s, draft: a.draft };
    case 'server': {
      if (a.revision === s.latestRevision && equals(a.value, s.latest)) return s; // nothing new
      const next = { ...s, latest: a.value, latestRevision: a.revision };
      if (equals(a.value, s.seed)) return { ...next, base: a.revision }; // not about this form: only the revision moved
      if (!isDirty(s, equals) || equals(s.draft, a.value)) return { draft: a.value, seed: a.value, base: a.revision, latest: a.value, latestRevision: a.revision };
      return next; // a conflict: the draft and the base stay
    }
    case 'theirs':
      return { draft: s.latest, seed: s.latest, base: s.latestRevision, latest: s.latest, latestRevision: s.latestRevision };
    case 'mine':
      return { ...s, draft: rebaseOntoLatest(s.draft, s.seed, s.latest), seed: s.latest, base: s.latestRevision };
    case 'acknowledge': {
      const conflict = hasConflict(s, equals);
      const fresh = newer(a.revision, s.latestRevision);
      const latest = fresh ? a.value : s.latest;
      const latestRevision = fresh ? a.revision : s.latestRevision;
      if (conflict) return { ...s, latest, latestRevision };
      return { ...s, seed: a.value, base: a.revision, latest, latestRevision };
    }
    case 'reset':
      return rebasedInit(a.value, a.revision);
  }
}

export interface RebasedForm<T> {
  value: T;
  setValue: (next: T | ((prev: T) => T)) => void;
  dirty: boolean;
  /** a teammate changed what this form holds while the person had edits */
  conflict: { by?: string } | null;
  /** send as expected_revision */
  expectedRevision: number | undefined;
  /** what the form started from: the value edits are compared with */
  seed: T;
  /** 用他的 */
  takeTheirs: () => void;
  /** 保留我的 */
  keepMine: () => void;
  /** the person's own save went through: pass what the server returned */
  acknowledge: (value: T, revision: number | undefined) => void;
  /** throw the edits away and start again from this value */
  reset: (value: T, revision: number | undefined) => void;
}

/**
 * `serverValue` is the form's part of the server's object (build it with the
 * same function every render; it is compared by value). Seeds once; later
 * server changes follow the rules above. `by` names the teammate for the
 * conflict notice, when known.
 */
export function useRebasedForm<T>(serverValue: T, opts: { revision?: number; by?: string | null; equals?: Equals<T> } = {}): RebasedForm<T> {
  const equals = opts.equals ?? sameValue;
  const [state, setState] = useState<RebasedState<T>>(() => rebasedInit(serverValue, opts.revision));

  // adjust during render (no effect, no flash of the old value): follow the server
  const followed = rebasedReduce(state, { type: 'server', value: serverValue, revision: opts.revision }, equals);
  if (followed !== state) setState(followed);
  const s = followed;

  const dispatch = useCallback((a: RebasedAction<T>) => setState((prev) => rebasedReduce(prev, a, equals)), [equals]);
  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => setState((prev) => rebasedReduce(prev, { type: 'edit', draft: typeof next === 'function' ? (next as (p: T) => T)(prev.draft) : next }, equals)),
    [equals],
  );

  return {
    value: s.draft,
    setValue,
    dirty: isDirty(s, equals),
    conflict: hasConflict(s, equals) ? (opts.by ? { by: opts.by } : {}) : null,
    expectedRevision: s.base,
    seed: s.seed,
    takeTheirs: () => dispatch({ type: 'theirs' }),
    keepMine: () => dispatch({ type: 'mine' }),
    acknowledge: (value, revision) => dispatch({ type: 'acknowledge', value, revision }),
    reset: (value, revision) => dispatch({ type: 'reset', value, revision }),
  };
}
