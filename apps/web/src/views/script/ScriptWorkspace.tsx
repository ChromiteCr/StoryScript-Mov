import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CurrentScript, Paragraph, Project, Shot, ShotDraft } from '@storyscript/contracts';
import { ScrollText, Upload } from 'lucide-react';
import { draftSceneId } from '../../lib/drafts.ts';
import { SCRIPT_FORMAT_LABEL } from '../../lib/labels.ts';
import { useAiGate, useDrafts, useEntities, useProviders, useScriptVersions, useShots } from '../../lib/queries.ts';
import { locateParagraph } from '../../lib/shots.ts';
import { stageDef } from '../../lib/stages.ts';
import { useMediaQuery, WIDE_QUERY } from '../../lib/useMediaQuery.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Tag } from '../../components/ui.tsx';
import { PageHeader, Panel, Workspace } from '../../components/workspace.tsx';
import { hostOf } from '../TextProviderPanel.tsx';
import { DraftDiffDialog } from './DraftDiffDialog.tsx';
import { EntitiesPanel } from './EntitiesPanel.tsx';
import { EntityDraftDialog } from './EntityDraftDialog.tsx';
import { InspectorBody, inspectorTitle } from './InspectorPanel.tsx';
import { ReasonDialog } from './ReasonDialog.tsx';
import { RevisionsDialog } from './RevisionsDialog.tsx';
import { ScenesPanel } from './ScenesPanel.tsx';
import { ScriptPane } from './ScriptPane.tsx';
import { ShotTable } from './ShotTable.tsx';
import {
  reveal,
  sceneGroupDomId,
  sceneHeadingDomId,
  shotRowDomId,
  WorkspaceContext,
  type Highlight,
  type InspectorTarget,
  type MainTab,
  type ReasonRequest,
  type ScriptWorkspace as WorkspaceValue,
} from './context.ts';

export interface ScriptWorkspaceProps {
  project: Project;
  script: CurrentScript;
  onImportNew: () => void;
  notice: string | null;
  onNotice: (message: string | null) => void;
}

const TABS: { id: MainTab; label: string }[] = [
  { id: 'shots', label: '镜头表' },
  { id: 'script', label: '剧本原文' },
  { id: 'roster', label: '场景与角色' },
];

/**
 * The script page with a script (S0a workbench):
 *   left: scenes + roster   main: script sheet (paper) | shot table   right: inspector
 * Below 1024px the main area shows one panel at a time and the inspector
 * opens as a drawer.
 */
export function ScriptWorkspace({ project, script, onImportNew, notice, onNotice }: ScriptWorkspaceProps) {
  const shots = useShots();
  const entities = useEntities();
  const drafts = useDrafts();
  const versions = useScriptVersions();
  const providers = useProviders();
  const gate = useAiGate();
  const ai = useMemo(() => ({ enabled: gate.enabled, reason: gate.reason, demo: gate.demo }), [gate.enabled, gate.reason, gate.demo]);
  const wide = useMediaQuery(WIDE_QUERY);

  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [inspector, setInspector] = useState<InspectorTarget | null>(() =>
    script.scenes[0] ? { kind: 'scene', sceneId: script.scenes[0].id } : null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<MainTab>('shots');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [entityDraftId, setEntityDraftId] = useState<string | null>(null);
  const [revisionsOf, setRevisionsOf] = useState<Shot | null>(null);
  const [reason, setReason] = useState<ReasonRequest | null>(null);
  const [relinkOnly, setRelinkOnly] = useState(false);
  const seq = useRef(0);
  const dirty = useRef(false);

  const paragraphs = useMemo(() => new Map<string, Paragraph>(script.version.paragraphs.map((p) => [p.id, p] as const)), [script.version.paragraphs]);
  const entityList = useMemo(() => entities.data ?? [], [entities.data]);
  const characters = useMemo(() => entityList.filter((e) => e.type === 'character'), [entityList]);
  const locations = useMemo(() => entityList.filter((e) => e.type === 'location'), [entityList]);
  const liveShots = useMemo(() => (shots.data ?? []).filter((s) => !s.archived), [shots.data]);

  const aliasLabel = useCallback(
    (alias: string) => {
      const e = entityList.find((x) => x.alias === alias);
      return e ? `${alias} ${e.name}` : `${alias}（不在名单中）`;
    },
    [entityList],
  );

  const showTab = useCallback((t: MainTab) => setTab(t), []);

  const locate = useCallback<WorkspaceValue['locate']>(
    (anchor, scroll = 'center') => {
      const pid = locateParagraph(script.version.paragraphs, anchor, script.version.id);
      if (!pid) {
        if (scroll === 'center') onNotice('当前剧本版本里找不到这段引用。');
        return;
      }
      seq.current += 1;
      setHighlight({ paragraphId: pid, quote: anchor?.quote.trim() ? anchor.quote : null, seq: seq.current, scroll });
      if (!wide && scroll === 'center') setTab('script');
    },
    [script.version, onNotice, wide],
  );

  /** Switching away from an edited shot asks first (the editor reports its dirty state). */
  const leaveEditor = useCallback(() => {
    if (!dirty.current) return true;
    if (!window.confirm('这个镜头有未保存的修改，放弃修改吗？')) return false;
    dirty.current = false;
    return true;
  }, []);

  const selectScene = useCallback<WorkspaceValue['selectScene']>(
    (scene, opts) => {
      if (!leaveEditor()) return;
      setInspector({ kind: 'scene', sceneId: scene.id, focus: opts?.focus });
      if (!wide && (opts?.focus || opts?.open)) setDrawerOpen(true);
      if (opts?.reveal) {
        if (wide) {
          reveal(sceneGroupDomId(scene.id));
          reveal(sceneHeadingDomId(scene.id));
        } else {
          setTab('shots');
          window.requestAnimationFrame(() => reveal(sceneGroupDomId(scene.id)));
        }
      }
    },
    [leaveEditor, wide],
  );

  const selectShot = useCallback<WorkspaceValue['selectShot']>(
    (shot, opts) => {
      if (!(inspector?.kind === 'shot' && inspector.shotId === shot.id) && !leaveEditor()) return;
      setInspector({ kind: 'shot', shotId: shot.id });
      if (!wide) setDrawerOpen(true);
      if (shot.source_anchor && !shot.needs_relink) locate(shot.source_anchor, wide ? 'nearest' : 'none');
      if (opts?.reveal) window.requestAnimationFrame(() => reveal(shotRowDomId(shot.id), 'nearest'));
    },
    [inspector, leaveEditor, wide, locate],
  );

  const openCreate = useCallback<WorkspaceValue['openCreate']>(
    (scene) => {
      if (!leaveEditor()) return;
      setInspector({ kind: 'create', sceneId: scene.id });
      if (!wide) setDrawerOpen(true);
    },
    [leaveEditor, wide],
  );

  const closeInspector = useCallback(() => {
    dirty.current = false;
    setDrawerOpen(false);
    setInspector((cur) => {
      if (!cur || cur.kind === 'scene') return cur ? { kind: 'scene', sceneId: cur.sceneId } : cur;
      if (cur.kind === 'create') return { kind: 'scene', sceneId: cur.sceneId };
      const s = liveShots.find((x) => x.id === cur.shotId);
      return s ? { kind: 'scene', sceneId: s.scene_id } : script.scenes[0] ? { kind: 'scene', sceneId: script.scenes[0].id } : null;
    });
  }, [liveShots, script.scenes]);

  const setEditorDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);

  // A shot that disappeared (archived elsewhere, deleted) leaves the inspector.
  useEffect(() => {
    if (inspector?.kind !== 'shot' || !shots.data) return;
    if (!liveShots.some((s) => s.id === inspector.shotId)) closeInspector();
  }, [inspector, liveShots, shots.data, closeInspector]);

  // Leave the page with unsaved edits: the browser asks.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const pendingDraftByScene = useMemo(() => {
    const m = new Map<string, ShotDraft>();
    const list = (drafts.data ?? [])
      .filter((d) => d.kind === 'breakdown' && d.status === 'pending')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const d of list) {
      const sid = draftSceneId(d);
      if (sid) m.set(sid, d); // newest wins
    }
    return m;
  }, [drafts.data]);

  const providerHost = ai.demo ? '演示回放（不外发）' : hostOf(providers.data?.text?.base_url);

  const ws = useMemo<WorkspaceValue>(
    () => ({
      project,
      script,
      paragraphs,
      entities: entityList,
      characters,
      locations,
      aliasLabel,
      ai,
      providerHost,
      wide,
      highlight,
      locate,
      inspector,
      selectScene,
      selectShot,
      openCreate,
      closeInspector,
      setEditorDirty,
      pendingDraftByScene,
      openDraft: setDraftId,
      openEntityDraft: setEntityDraftId,
      openRevisions: setRevisionsOf,
      askReason: setReason,
      notify: onNotice,
      showTab,
    }),
    [
      project,
      script,
      paragraphs,
      entityList,
      characters,
      locations,
      aliasLabel,
      ai,
      providerHost,
      wide,
      highlight,
      locate,
      inspector,
      selectScene,
      selectShot,
      openCreate,
      closeInspector,
      setEditorDirty,
      pendingDraftByScene,
      onNotice,
      showTab,
    ],
  );

  const relinkCount = useMemo(() => liveShots.filter((s) => s.needs_relink).length, [liveShots]);

  const versionNo = useMemo(() => {
    const list = versions.data ?? [];
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const i = sorted.findIndex((v) => v.id === script.version.id);
    return { n: i >= 0 ? i + 1 : null, total: list.length };
  }, [versions.data, script.version.id]);

  const v = script.version;
  const { label } = stageDef('script');

  const header = (
    <PageHeader
      title={label}
      icon={ScrollText}
      status={<Tag>{versionNo.n ? `第 ${versionNo.n} 版${versionNo.total > 1 ? ` / 共 ${versionNo.total} 版` : ''}` : '当前版本'}</Tag>}
      lead={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 break-all text-graphite-100">{v.source_name}</span>
          <span>{SCRIPT_FORMAT_LABEL[v.format]}</span>
          <span className="tabular-nums">{new Date(v.created_at).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}</span>
          <span className="tabular-nums">
            {script.scenes.length} 场 · {liveShots.length} 镜
          </span>
        </span>
      }
      actions={
        <>
          {relinkCount > 0 ? (
            <Button
              variant="ghost"
              onClick={() => {
                setRelinkOnly((r) => !r);
                setTab('shots');
              }}
              aria-pressed={relinkOnly}
              title="剧本改版后，这些镜头引用的原文在新版本里找不到逐字相同的句子"
              className={relinkOnly ? 'bg-graphite-800 text-graphite-100' : ''}
            >
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              {relinkOnly ? '显示全部镜头' : `${relinkCount} 个待重新关联`}
            </Button>
          ) : null}
          <Button onClick={onImportNew}>
            <Upload aria-hidden className="size-3.5" />
            导入新版本
          </Button>
        </>
      }
    />
  );

  const scriptPanel = <ScriptPane />;
  const shotPanel = <ShotTable shotsQuery={shots} relinkOnly={relinkOnly} notice={notice} onDismissNotice={() => onNotice(null)} />;
  const scenesPanel = <ScenesPanel shots={liveShots} />;
  const entitiesPanel = <EntitiesPanel entitiesQuery={entities} />;

  const inspectorPanel = (
    <Panel title={inspectorTitle(inspector, liveShots, script.scenes)} padded={false}>
      <InspectorBody target={inspector} shots={liveShots} />
    </Panel>
  );

  let body;
  if (wide) {
    body = (
      <Workspace
        header={header}
        left={
          <>
            {scenesPanel}
            {entitiesPanel}
          </>
        }
        right={inspectorPanel}
      >
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-1">
          {scriptPanel}
          {shotPanel}
        </div>
      </Workspace>
    );
  } else {
    body = (
      <Workspace header={header}>
        <div className="flex min-h-full flex-col gap-1">
          <div role="tablist" aria-label="剧本页面板" className="flex shrink-0 gap-0.5 rounded-panel bg-graphite-900 p-0.5">
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
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="flex min-h-[60dvh] flex-1 flex-col gap-1">
            {tab === 'script' ? scriptPanel : tab === 'shots' ? shotPanel : (
              <>
                {scenesPanel}
                {entitiesPanel}
              </>
            )}
          </div>
        </div>
      </Workspace>
    );
  }

  return (
    <WorkspaceContext.Provider value={ws}>
      {body}
      {!wide && drawerOpen && inspector ? (
        <Dialog variant="drawer" title={inspectorTitle(inspector, liveShots, script.scenes)} onClose={() => (leaveEditor() ? closeInspector() : undefined)} bodyClassName="">
          <InspectorBody target={inspector} shots={liveShots} />
        </Dialog>
      ) : null}
      {draftId ? <DraftDiffDialog draftId={draftId} onClose={() => setDraftId(null)} /> : null}
      {entityDraftId ? <EntityDraftDialog draftId={entityDraftId} onClose={() => setEntityDraftId(null)} /> : null}
      {revisionsOf ? <RevisionsDialog shot={revisionsOf} onClose={() => setRevisionsOf(null)} /> : null}
      {reason ? <ReasonDialog request={reason} onClose={() => setReason(null)} /> : null}
    </WorkspaceContext.Provider>
  );
}

