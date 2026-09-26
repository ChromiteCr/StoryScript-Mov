import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BoardSpec, type BoardView, type Project, type Shot } from '@storyscript/contracts';
import { Map as MapIcon, PanelsTopLeft, Printer, ScrollText } from 'lucide-react';
import { sceneLabel } from '../../lib/print-boards.ts';
import { RENDER_MODE_LABEL, type BoardViewMode } from '../../lib/labels-boards.ts';
import { useCurrentProject } from '../../lib/queries.ts';
import {
  useBoards,
  useBoardScript,
  useBoardScriptVersions,
  useBoardShots,
  useBoardVersions,
  useKeepBoard,
  useRegenerateBoard,
  useSaveBoard,
} from '../../lib/queries-boards.ts';
import { pageHref, stageDef } from '../../lib/stages.ts';
import { useMediaQuery, WIDE_QUERY } from '../../lib/useMediaQuery.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Notice, Spinner, Tag } from '../../components/ui.tsx';
import { EmptyState, PageHeader, Panel, Workspace } from '../../components/workspace.tsx';
import { BoardInspector } from './BoardInspector.tsx';
import { BoardMain } from './BoardMain.tsx';
import { BoardPrint, type PrintKind } from './BoardPrint.tsx';
import { ShotStrip, type SceneGroup } from './ShotStrip.tsx';
import { useBoardEditor } from './useEditor.ts';

/**
 * #/boards — the storyboard page (U-02, FR-04):
 *   left: every shot's board as a thumbnail, by scene in narrative order
 *   main: the selected board on paper with its handles, caption and topview
 *   right: the inspector (person / camera / annotations)
 * Below 1024px the three panels become tabs. Print views (board PDF,
 * topview pages) replace the workspace, like the plan page's.
 */

const SELECTED_KEY = 'storyscript.boards.selected';
const THUMB_MODE_KEY = 'storyscript.boards.thumbMode';

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

const DRAFT_KEY = 'storyscript.boards.draft';

interface StoredDraft {
  boardId: string;
  revision: number;
  spec: unknown;
}

function readDraft(): StoredDraft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(d: StoredDraft): void {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // best effort
  }
}

function clearDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // best effort
  }
}

type Tab = 'shots' | 'board' | 'edit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'shots', label: '镜头' },
  { id: 'board', label: '分镜稿' },
  { id: 'edit', label: '属性' },
];

/** Default export for React.lazy (App.tsx): the page loads as its own chunk. */
export default function BoardsRoute() {
  const project = useCurrentProject();
  if (!project.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="正在读取项目…" />
      </div>
    );
  }
  return <BoardsPage project={project.data} />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-4">{children}</div>;
}

function BoardsPage({ project }: { project: Project }) {
  const boards = useBoards();
  const shots = useBoardShots();
  const script = useBoardScript();
  const scriptVersions = useBoardScriptVersions();
  const { label, lead } = stageDef('boards');

  const [print, setPrint] = useState<{ kind: PrintKind; sceneId: string | null } | null>(null);

  const shotMap = useMemo(() => new Map<string, Shot>((shots.data ?? []).map((s) => [s.id, s])), [shots.data]);
  const scenes = useMemo(() => script.data?.scenes ?? [], [script.data]);
  const list = useMemo(() => boards.data ?? [], [boards.data]);
  const groups = useMemo<SceneGroup[]>(() => {
    const out: SceneGroup[] = [];
    for (const b of list) {
      let g = out[out.length - 1];
      if (!g || g.id !== b.scene_id) {
        g = { id: b.scene_id, label: sceneLabel(scenes.find((s) => s.id === b.scene_id)), boards: [] };
        out.push(g);
      }
      g.boards.push(b);
    }
    return out;
  }, [list, scenes]);

  const scriptVersion = useMemo(() => {
    const v = scriptVersions.data ?? [];
    const cur = script.data?.version.id;
    const sorted = [...v].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const i = sorted.findIndex((x) => x.id === cur);
    return i >= 0 ? `剧本第 ${i + 1} 版` : null;
  }, [scriptVersions.data, script.data]);

  const staleCount = list.filter((b) => b.stale).length;
  const header = (
    <PageHeader
      title={label}
      icon={PanelsTopLeft}
      status={
        list.length ? (
          <span className="flex items-center gap-1.5">
            <Tag>{list.length} 格</Tag>
            {staleCount ? <Tag tone="warn">{staleCount} 格镜头已改</Tag> : null}
          </span>
        ) : undefined
      }
      lead={lead}
      actions={
        list.length ? (
          <>
            <Button onClick={() => setPrint({ kind: 'boards', sceneId: null })}>
              <Printer aria-hidden className="size-3.5" />
              打印分镜
            </Button>
            <Button onClick={() => setPrint({ kind: 'topview', sceneId: null })}>
              <MapIcon aria-hidden className="size-3.5" />
              俯视站位页
            </Button>
          </>
        ) : undefined
      }
    />
  );

  const error = boards.error ?? shots.error ?? script.error;
  if (error) {
    return (
      <Workspace header={header}>
        <Panel title="分镜稿">
          <div className="flex max-w-[520px] flex-col items-start gap-3">
            <ErrorNotice error={error} />
            <Button
              onClick={() => {
                void boards.refetch();
                void shots.refetch();
                void script.refetch();
              }}
            >
              重试
            </Button>
          </div>
        </Panel>
      </Workspace>
    );
  }
  if (boards.isPending || shots.isPending || script.isPending) {
    return (
      <Centered>
        <Spinner label="正在读取分镜…" />
      </Centered>
    );
  }
  if (list.length === 0) {
    return (
      <Workspace header={header}>
        <Panel title="分镜稿">
          <EmptyState
            icon={PanelsTopLeft}
            title={script.data ? '还没有镜头。' : '还没有剧本。'}
            description="在剧本页拆镜或手工新建镜头后，每个镜头会自动出一格分镜（结构线稿和铅笔稿都不需要模型）。"
            action={
              <a href={pageHref('script')} className="inline-flex h-7 items-center gap-1.5 rounded-control border border-graphite-700 bg-graphite-800 px-3 text-sm text-graphite-100 hover:border-graphite-500">
                <ScrollText aria-hidden className="size-3.5" />
                去剧本页
              </a>
            }
          />
        </Panel>
      </Workspace>
    );
  }

  if (print) {
    return (
      <BoardPrint
        kind={print.kind}
        project={project}
        boards={list}
        shots={shots.data ?? []}
        scenes={scenes}
        scriptVersion={scriptVersion}
        sceneId={print.sceneId}
        onScene={(sceneId) => setPrint({ ...print, sceneId })}
        onBack={() => setPrint(null)}
      />
    );
  }

  return <BoardsWorkbench header={header} list={list} groups={groups} shotMap={shotMap} project={project} sceneSides={(id) => scenes.find((s) => s.id === id)?.screen_sides ?? null} />;
}

function BoardsWorkbench({
  header,
  list,
  groups,
  shotMap,
  project,
  sceneSides,
}: {
  header: ReactNode;
  list: BoardView[];
  groups: SceneGroup[];
  shotMap: Map<string, Shot>;
  project: Project;
  sceneSides: (sceneId: string) => { left: string | null; right: string | null } | null;
}) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [selected, setSelected] = useState<string | null>(() => readStore(SELECTED_KEY));
  const [thumbMode, setThumbMode] = useState<BoardViewMode>(() => (readStore(THUMB_MODE_KEY) === 'structure' ? 'structure' : 'pencil'));
  const [mode, setMode] = useState<BoardViewMode>('pencil');
  const [keepSize, setKeepSize] = useState(true);
  const [tab, setTab] = useState<Tab>('board');
  const [viewId, setViewId] = useState<string | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);

  const current = list.find((b) => b.shot_id === selected) ?? list[0]!;
  const shot = shotMap.get(current.shot_id);
  const editor = useBoardEditor(current, viewId === null);
  const versions = useBoardVersions(current.shot_id);
  const save = useSaveBoard();
  const keep = useKeepBoard();
  const regen = useRegenerateBoard();
  const viewing = viewId ? (versions.data?.find((v) => v.id === viewId && v.id !== current.id) ?? null) : null;

  const dirty = useRef(editor.dirty);
  dirty.current = editor.dirty;

  useEffect(() => writeStore(SELECTED_KEY, current.shot_id), [current.shot_id]);
  // a new base version (saved, regenerated, reloaded) clears the last save error
  const resetSave = save.reset;
  useEffect(() => resetSave(), [editor.base.id, resetSave]);
  useEffect(() => writeStore(THUMB_MODE_KEY, thumbMode), [thumbMode]);

  // Unsaved edits survive a trip to another page (or a reload) in this tab:
  // kept in sessionStorage against the version they were made on, restored
  // as one undoable step when that version is opened again.
  const restored = useRef<string | null>(null);
  const { base, present, commit } = editor;
  useEffect(() => {
    if (restored.current === base.id) return;
    restored.current = base.id;
    const d = readDraft();
    if (!d || d.boardId !== base.id || d.revision !== base.revision) return;
    const parsed = BoardSpec.safeParse(d.spec);
    if (parsed.success) commit('恢复未保存的修改', parsed.data);
  }, [base.id, base.revision, commit]);
  useEffect(() => {
    if (restored.current !== base.id) return;
    if (editor.dirty) writeDraft({ boardId: base.id, revision: base.revision, spec: present });
    else if (readDraft()?.boardId === base.id) clearDraft();
  }, [editor.dirty, present, base.id, base.revision]);

  // Leaving the page (or reloading) with unsaved edits: the browser asks.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const select = useCallback(
    (shotId: string) => {
      if (shotId === current.shot_id) {
        if (!wide) setTab('board');
        return;
      }
      if (dirty.current && !window.confirm('这一格有未保存的修改，放弃修改并切换镜头吗？')) return;
      clearDraft();
      setSelected(shotId);
      setViewId(null);
      setSpecError(null);
      save.reset();
      keep.reset();
      regen.reset();
      if (!wide) setTab('board');
    },
    [current.shot_id, wide, save, keep, regen],
  );

  const onSave = () => {
    const parsed = BoardSpec.safeParse(editor.present);
    if (!parsed.success) {
      setSpecError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
      return;
    }
    setSpecError(null);
    save.mutate({ boardId: editor.base.id, revision: editor.base.revision, spec: parsed.data }, { onSuccess: (view) => editor.reset(view) });
  };

  const onRegenerate = () => {
    if (editor.dirty && !window.confirm('重新生成会按镜头字段重新布局，未保存的修改和手动调整都会丢失。继续吗？')) return;
    regen.mutate(current.shot_id, { onSuccess: (view) => editor.reset(view) });
  };

  const onKeep = () => keep.mutate({ boardId: editor.base.id, revision: editor.base.revision });

  const thumbTools = (
    <div role="radiogroup" aria-label="缩略图显示" className="flex items-center gap-0.5">
      {(['pencil', 'structure'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={thumbMode === m}
          onClick={() => setThumbMode(m)}
          className={
            'h-5 rounded-control px-1.5 text-xs ' +
            (thumbMode === m ? 'bg-graphite-700 text-graphite-100' : 'text-graphite-300 hover:bg-graphite-700 hover:text-graphite-100')
          }
        >
          {m === 'pencil' ? '铅笔' : '结构'}
        </button>
      ))}
    </div>
  );

  const left = (
    <Panel title="镜头" tools={thumbTools} padded={false}>
      <ShotStrip groups={groups} shots={shotMap} selectedShotId={current.shot_id} mode={thumbMode} onSelect={select} />
    </Panel>
  );

  const main = (
    <BoardMain
      project={project}
      board={current}
      editor={editor}
      shot={shot}
      mode={mode}
      onMode={setMode}
      versions={versions.data}
      viewing={viewing}
      onView={setViewId}
      onSave={onSave}
      saving={save.isPending}
      saveError={specError ? new Error(`分镜数据无效：${specError}`) : save.error}
      onRegenerate={onRegenerate}
      regenerating={regen.isPending}
      onKeep={onKeep}
      keeping={keep.isPending}
      staleError={regen.error ?? keep.error}
    />
  );

  const right = (
    <Panel title={`属性 · 镜 ${current.shot_code}`} padded={false}>
      {viewing ? (
        <div className="p-3">
          <Notice tone="info" title="旧版本只读">
            回到最新版本后才能编辑。
          </Notice>
        </div>
      ) : null}
      <BoardInspector editor={editor} readOnly={viewing !== null} viewSpec={viewing?.spec ?? null} fields={shot?.fields} keepSize={keepSize} onKeepSize={setKeepSize} sceneSides={sceneSides(current.scene_id)} />
    </Panel>
  );

  if (wide) {
    return (
      <Workspace header={header} left={left} right={right}>
        {main}
      </Workspace>
    );
  }
  return (
    <Workspace header={header}>
      <div className="flex min-h-full flex-col gap-1">
        <div role="tablist" aria-label="分镜页面板" className="flex shrink-0 gap-0.5 rounded-panel bg-graphite-900 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={
                'h-8 flex-1 rounded-control text-sm focus-visible:outline-offset-[-2px] ' +
                (tab === t.id ? 'bg-graphite-800 font-medium text-graphite-100' : 'text-graphite-300 hover:text-graphite-100')
              }
            >
              {t.id === 'board' ? `${t.label} · ${current.shot_code}` : t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="flex min-h-[60dvh] flex-1 flex-col gap-1">
          {tab === 'shots' ? left : tab === 'board' ? main : right}
        </div>
        <p className="sr-only" aria-live="polite">
          {editor.dragging ? `拖动中，显示${RENDER_MODE_LABEL.structure}` : ''}
        </p>
      </div>
    </Workspace>
  );
}
