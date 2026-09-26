import { useSyncExternalStore } from 'react';

/**
 * Save indicator state (FR-01: "已保存" only after the transaction commits).
 * Editing features call these; until then the bar shows "尚无改动".
 */

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string };

let state: SaveState = { kind: 'idle' };
let pending = 0;
const listeners = new Set<() => void>();

function set(next: SaveState): void {
  state = next;
  for (const l of listeners) l();
}

export function markSaving(): void {
  pending += 1;
  set({ kind: 'saving' });
}

export function markSaved(): void {
  pending = Math.max(0, pending - 1);
  if (pending === 0) set({ kind: 'saved', at: new Date() });
}

export function markSaveFailed(message: string): void {
  pending = Math.max(0, pending - 1);
  set({ kind: 'error', message });
}

export function resetSaveState(): void {
  pending = 0;
  set({ kind: 'idle' });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSaveState(): SaveState {
  return useSyncExternalStore(subscribe, () => state);
}
