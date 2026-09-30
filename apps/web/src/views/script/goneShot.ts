import { createContext, useContext } from 'react';

/**
 * S4a: the id of the shot a teammate archived while it was open in the
 * inspector with unsaved edits, or null. The workspace keeps such a shot on
 * screen (read-only, with what was typed); its editor reads this to say so.
 */
export const GoneShotContext = createContext<string | null>(null);

export function useGoneShotId(): string | null {
  return useContext(GoneShotContext);
}
