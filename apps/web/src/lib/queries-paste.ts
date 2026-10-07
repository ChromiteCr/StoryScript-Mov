import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApplyPasteInput, CreatePasteInput, CreateTodoInput, PasteHint, PasteNoteView, Todo, UpdateTodoInput } from '@storyscript/contracts';
import { api } from './api.ts';
import { refetchOnConflict } from './queries.ts';

/**
 * S5a: paste notes live under ['drafts', 'paste', …] (a teammate's job or
 * apply moves the drafts area), todos under ['plan', 'todos']. Applying
 * writes to the plan, the set's takes and the script's entities, so those
 * roots refresh too.
 */

export const pasteKeys = {
  list: ['drafts', 'paste', 'list'] as const,
  note: (id: string) => ['drafts', 'paste', 'note', id] as const,
  todos: ['plan', 'todos'] as const,
};

export function usePasteNotes(enabled = true) {
  return useQuery({ queryKey: pasteKeys.list, queryFn: ({ signal }) => api.call('listPasteNotes', undefined, { signal }), enabled, staleTime: 0 });
}

/** One note; polled once a second while a segment is still being sorted. */
export function usePasteNote(id: string | null) {
  return useQuery({
    queryKey: pasteKeys.note(id ?? ''),
    queryFn: ({ signal }) => api.call('getPasteNote', undefined, { signal, params: { id: id! } }),
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (q) => ((q.state.data as PasteNoteView | undefined)?.pending_segments ? 1000 : false),
  });
}

export function useCreatePaste() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePasteInput) => api.call('createPasteNote', input),
    onSuccess: (note) => {
      qc.setQueryData(pasteKeys.note(note.id), note);
      void qc.invalidateQueries({ queryKey: pasteKeys.list });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useRetryPasteSegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idx }: { id: string; idx: number }) => api.call('retryPasteSegment', undefined, { params: { id, idx: String(idx) } }),
    onSuccess: (note) => qc.setQueryData(pasteKeys.note(note.id), note),
  });
}

export function useApplyPaste() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApplyPasteInput }) => api.call('applyPasteNote', input, { params: { id } }),
    onSuccess: (res) => {
      qc.setQueryData(pasteKeys.note(res.note.id), res.note);
      for (const root of [['drafts', 'paste', 'list'], ['plan'], ['m6'], ['deliver'], ['entities']]) void qc.invalidateQueries({ queryKey: root });
    },
    onError: (_e, { id }) => void qc.invalidateQueries({ queryKey: pasteKeys.note(id) }),
  });
}

export function useClosePaste() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.call('closePasteNote', undefined, { params: { id } }),
    onSuccess: (note) => {
      qc.setQueryData(pasteKeys.note(note.id), note);
      void qc.invalidateQueries({ queryKey: pasteKeys.list });
    },
  });
}

// --------------------------------------------------------------------- todos

export function useTodos() {
  return useQuery({ queryKey: pasteKeys.todos, queryFn: ({ signal }) => api.call('listTodos', undefined, { signal }) });
}

function useRefreshTodos() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: pasteKeys.todos });
}

export function useCreateTodo() {
  const refresh = useRefreshTodos();
  return useMutation({ mutationFn: (input: CreateTodoInput) => api.call('createTodo', input), onSuccess: refresh });
}

export function useUpdateTodo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTodoInput }) => api.call('updateTodo', input, { params: { id } }),
    onSuccess: (todo: Todo) => qc.setQueryData<Todo[]>(pasteKeys.todos, (old) => old?.map((t) => (t.id === todo.id ? todo : t))),
    onError: refetchOnConflict(qc, pasteKeys.todos),
    onSettled: () => void qc.invalidateQueries({ queryKey: pasteKeys.todos }),
  });
}

export function useDeleteTodo() {
  const refresh = useRefreshTodos();
  return useMutation({ mutationFn: (id: string) => api.call('deleteTodo', undefined, { params: { id } }), onSuccess: refresh });
}

// ------------------------------------------------------- the dialog, anywhere

interface PasteOpen {
  open: boolean;
  hint: PasteHint;
  /** a note to show at once (e.g. from a job line) */
  noteId: string | null;
}

let state: PasteOpen = { open: false, hint: 'auto', noteId: null };
const listeners = new Set<() => void>();
const emit = (next: PasteOpen) => {
  state = next;
  for (const l of listeners) l();
};

export function openPaste(hint: PasteHint = 'auto', noteId: string | null = null): void {
  emit({ open: true, hint, noteId });
}

export function closePasteDialog(): void {
  if (state.open) emit({ ...state, open: false });
}

export function usePasteOpen(): PasteOpen {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
