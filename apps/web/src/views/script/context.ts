import { createContext, useContext, type ReactNode } from 'react';
import type { CurrentScript, Entity, Paragraph, Project, Scene, Shot } from '@storyscript/contracts';
import type { ErrorContext } from '../../lib/errors.ts';
import type { AiGate } from '../../lib/queries.ts';

/** Paragraph the left pane should scroll to and highlight. `seq` re-triggers the same target. */
export interface Highlight {
  paragraphId: string;
  quote: string | null;
  seq: number;
}

export interface ReasonRequest {
  title: string;
  description?: ReactNode;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  danger?: boolean;
  errorContext?: ErrorContext;
  run: (reason: string) => Promise<unknown>;
}

export interface Workspace {
  project: Project;
  script: CurrentScript;
  paragraphs: ReadonlyMap<string, Paragraph>;
  entities: readonly Entity[];
  characters: readonly Entity[];
  locations: readonly Entity[];
  /** "c1 林某" style label for an alias; unknown aliases are flagged */
  aliasLabel: (alias: string) => string;
  ai: AiGate;
  /** host of the configured text provider, for the outgoing-data note */
  providerHost: string | null;
  highlight: Highlight | null;
  locate: (anchor: { paragraph_id: string; quote: string; script_version_id?: string } | null) => void;
  openEditor: (shot: Shot) => void;
  openCreate: (scene: Scene) => void;
  openDraft: (draftId: string) => void;
  openRevisions: (shot: Shot) => void;
  askReason: (req: ReasonRequest) => void;
  notify: (message: string) => void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error('useWorkspace outside WorkspaceContext');
  return ws;
}
