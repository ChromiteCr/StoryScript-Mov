import { createContext, useContext, type ReactNode } from 'react';
import type { CurrentScript, Entity, Paragraph, Project, Scene, Shot, ShotDraft } from '@storyscript/contracts';
import type { ErrorContext } from '../../lib/errors.ts';
import type { AiGate } from '../../lib/queries.ts';

/** Paragraph the script sheet should highlight. `seq` re-triggers scrolling to the same target. */
export interface Highlight {
  paragraphId: string;
  quote: string | null;
  seq: number;
  /** how far to scroll: a deliberate "locate" centres, a selection only nudges */
  scroll: 'center' | 'nearest' | 'none';
}

export interface ReasonRequest {
  title: string;
  description?: ReactNode;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  errorContext?: ErrorContext;
  run: (reason: string) => Promise<unknown>;
}

/**
 * What the right-hand inspector shows: a scene (its setup and AI breakdown),
 * a shot (the editor) or the form for a new manual shot.
 */
export type InspectorTarget =
  | { kind: 'scene'; sceneId: string; focus?: 'breakdown' | 'setup' }
  | { kind: 'shot'; shotId: string }
  | { kind: 'create'; sceneId: string };

/** Narrow screens: the main area shows one panel at a time. */
export type MainTab = 'script' | 'shots' | 'roster' | 'check';

export type AnchorLike = { paragraph_id: string; quote: string; script_version_id?: string };

export interface ScriptWorkspace {
  project: Project;
  script: CurrentScript;
  paragraphs: ReadonlyMap<string, Paragraph>;
  entities: readonly Entity[];
  characters: readonly Entity[];
  locations: readonly Entity[];
  /** "c1 老周" for an alias; unknown aliases are flagged */
  aliasLabel: (alias: string) => string;
  ai: AiGate;
  /** where AI requests go, for the outgoing-data note ("api.deepseek.com", or the demo replay) */
  providerHost: string | null;
  /** ≥1024px: panels side by side, the inspector is a column; below, it is a drawer */
  wide: boolean;
  highlight: Highlight | null;
  /** scroll the script to an anchor and highlight it */
  locate: (anchor: AnchorLike | null, scroll?: Highlight['scroll']) => void;
  inspector: InspectorTarget | null;
  /** focus: which inspector group to bring into view; open: show the drawer on narrow screens */
  selectScene: (scene: Scene, opts?: { focus?: 'breakdown' | 'setup'; reveal?: boolean; open?: boolean }) => void;
  selectShot: (shot: Shot, opts?: { reveal?: boolean }) => void;
  openCreate: (scene: Scene) => void;
  /** leave the shot editor (back to its scene on wide screens, close the drawer on narrow ones) */
  closeInspector: () => void;
  /** the shot editor reports unsaved edits here, so switching asks first */
  setEditorDirty: (dirty: boolean) => void;
  pendingDraftByScene: ReadonlyMap<string, ShotDraft>;
  openDraft: (draftId: string) => void;
  openEntityDraft: (draftId: string) => void;
  openRevisions: (shot: Shot) => void;
  /** open the style library drawer (S3) */
  openStyles: () => void;
  /** S3a: 选择 mode of the shot table (a tick on every row) */
  selecting: boolean;
  /** leaving selection mode clears the selection */
  setSelecting: (on: boolean) => void;
  /** ids of the ticked shots; locked and gone shots are never in it */
  selected: ReadonlySet<string>;
  toggleSelect: (shotId: string) => void;
  /** tick (on) or untick several shots; locked ones are skipped when ticking */
  selectMany: (shotIds: readonly string[], on: boolean) => void;
  clearSelection: () => void;
  /** open the AI 润色 request for these shots */
  openPolish: (shotIds: string[]) => void;
  /** open a polish draft for review */
  openPolishDraft: (draftId: string) => void;
  /** polish drafts still waiting for review, newest first */
  pendingPolishDrafts: readonly ShotDraft[];
  askReason: (req: ReasonRequest) => void;
  notify: (message: string) => void;
  showTab: (tab: MainTab) => void;
}

export const WorkspaceContext = createContext<ScriptWorkspace | null>(null);

export function useWorkspace(): ScriptWorkspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error('useWorkspace outside WorkspaceContext');
  return ws;
}

export const paragraphDomId = (id: string) => `para-${id}`;
export const sceneHeadingDomId = (id: string) => `scene-heading-${id}`;
export const sceneGroupDomId = (id: string) => `scene-shots-${id}`;
export const shotRowDomId = (id: string) => `shot-${id}`;

/** Scroll an element into view, respecting reduced motion. */
export function reveal(id: string, block: ScrollLogicalPosition = 'start'): void {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block, behavior: reduce ? 'auto' : 'smooth' });
}
