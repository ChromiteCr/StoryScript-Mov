import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardSpec, BoardView } from '@storyscript/contracts';
import {
  canRedo,
  canUndo,
  historyCommit,
  historyInit,
  historyRedo,
  historyShortcut,
  historyUndo,
  isDirty,
  redoLabel,
  specKey,
  undoLabel,
  type EditHistory,
} from '../../lib/board-editor.ts';

/**
 * Editor state for the selected shot's newest board version:
 *  - history: committed commands (undo/redo, Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z);
 *  - preview: the spec while a handle or slider is being dragged (not in the
 *    history until release; the canvas renders structure meanwhile);
 *  - selection: the person / arrow / label the inspector edits.
 * When the server's newest version changes (save, regenerate, another tab)
 * the editor starts over from it — unless there are unsaved edits, which are
 * kept and flagged as a conflict until the user reloads.
 */

export type Selection = { kind: 'subject'; id: string } | { kind: 'arrow'; id: string } | null;

export interface EditorApi {
  /** base version being edited (the shot's newest) */
  base: BoardView;
  /** what the canvas shows (preview while dragging) */
  spec: BoardSpec;
  /** committed state */
  present: BoardSpec;
  dragging: boolean;
  dirty: boolean;
  /** a newer version arrived while there were unsaved edits */
  conflict: BoardView | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  selection: Selection;
  select(s: Selection): void;
  commit(label: string, next: BoardSpec): void;
  preview(next: BoardSpec): void;
  /** end a drag: commit the previewed spec (or drop it) */
  endPreview(label: string | null): void;
  undo(): void;
  redo(): void;
  /** start over from the given version (discarding edits) */
  reset(to: BoardView): void;
}

function editableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return false;
}

export function useBoardEditor(latest: BoardView, enabled: boolean): EditorApi {
  const [base, setBase] = useState<BoardView>(latest);
  const [history, setHistory] = useState<EditHistory>(() => historyInit(latest.spec));
  const [previewSpec, setPreviewSpec] = useState<BoardSpec | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [conflict, setConflict] = useState<BoardView | null>(null);
  const previewRef = useRef<BoardSpec | null>(null);

  // Another shot: start over right away (adjusting state during render, so
  // the canvas never shows one frame of the previous shot).
  if (latest.shot_id !== base.shot_id) {
    setBase(latest);
    setHistory(historyInit(latest.spec));
    setPreviewSpec(null);
    setSelection(null);
    setConflict(null);
    previewRef.current = null;
  }

  const dirty = useMemo(() => isDirty(history, base.spec), [history, base.spec]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const reset = useCallback((to: BoardView) => {
    setBase(to);
    setHistory(historyInit(to.spec));
    previewRef.current = null;
    setPreviewSpec(null);
    setConflict(null);
    setSelection((s) => {
      if (!s) return s;
      const ok = s.kind === 'subject' ? to.spec.scene.subjects.some((x) => x.id === s.id) : to.spec.overlay.arrows.some((x) => x.id === s.id);
      return ok ? s : null;
    });
  }, []);

  // A different newest version (or the same one re-based by "keep").
  useEffect(() => {
    if (latest.id === base.id) {
      if (latest.revision !== base.revision || latest.stale !== base.stale) setBase(latest);
      return;
    }
    if (latest.shot_id !== base.shot_id) return; // handled during render
    if (!dirtyRef.current || specKey(latest.spec) === specKey(history.present.spec)) {
      reset(latest);
      return;
    }
    setConflict(latest);
  }, [latest, base, history.present.spec, reset]);

  const commit = useCallback((label: string, next: BoardSpec) => {
    previewRef.current = null;
    setPreviewSpec(null);
    setHistory((h) => historyCommit(h, label, next));
  }, []);

  const preview = useCallback((next: BoardSpec) => {
    previewRef.current = next;
    setPreviewSpec(next);
  }, []);

  const endPreview = useCallback((label: string | null) => {
    const p = previewRef.current;
    previewRef.current = null;
    setPreviewSpec(null);
    if (p && label) setHistory((h) => historyCommit(h, label, p));
  }, []);

  const undo = useCallback(() => setHistory((h) => historyUndo(h)), []);
  const redo = useCallback(() => setHistory((h) => historyRedo(h)), []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const which = historyShortcut(e);
      if (!which || editableTarget(e.target)) return;
      e.preventDefault();
      if (which === 'undo') undo();
      else redo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, undo, redo]);

  return {
    base,
    spec: previewSpec ?? history.present.spec,
    present: history.present.spec,
    dragging: previewSpec !== null,
    dirty,
    conflict,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undoLabel: undoLabel(history),
    redoLabel: redoLabel(history),
    selection,
    select: setSelection,
    commit,
    preview,
    endPreview,
    undo,
    redo,
    reset,
  };
}
