import { useCallback, useMemo, useRef, useState } from 'react';
import type { CurrentScript, Paragraph, Project, Scene, Shot, ShotDraft } from '@storyscript/contracts';
import { FileText, Upload, X } from 'lucide-react';
import { draftSceneId } from '../../lib/drafts.ts';
import { SCRIPT_FORMAT_LABEL } from '../../lib/labels.ts';
import { useAiGate, useDrafts, useEntities, useProviders, useScriptVersions, useShots } from '../../lib/queries.ts';
import { groupShotsByScene, locateParagraph } from '../../lib/shots.ts';
import { ErrorNotice } from '../../components/ErrorNotice.tsx';
import { Button, Note, Spinner, Tag } from '../../components/ui.tsx';
import { DraftDiffDialog } from './DraftDiffDialog.tsx';
import { EntitiesPanel } from './EntitiesPanel.tsx';
import { EntityDraftDialog } from './EntityDraftDialog.tsx';
import { ReasonDialog } from './ReasonDialog.tsx';
import { RevisionsDialog } from './RevisionsDialog.tsx';
import { SceneSection } from './SceneSection.tsx';
import { ScriptPane, sceneDomId } from './ScriptPane.tsx';
import { ShotEditor, type EditorTarget } from './ShotEditor.tsx';
import { WorkspaceContext, type Highlight, type ReasonRequest, type Workspace as WorkspaceValue } from './context.ts';

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export interface WorkspaceProps {
  project: Project;
  script: CurrentScript;
  onImportNew: () => void;
  initialNotice: string | null;
}

export function Workspace({ project, script, onImportNew, initialNotice }: WorkspaceProps) {
  const shots = useShots();
  const entities = useEntities();
  const drafts = useDrafts();
  const versions = useScriptVersions();
  const providers = useProviders();
  const ai = useAiGate();

  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [entityDraftId, setEntityDraftId] = useState<string | null>(null);
  const [revisionsOf, setRevisionsOf] = useState<Shot | null>(null);
  const [reason, setReason] = useState<ReasonRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [relinkOnly, setRelinkOnly] = useState(false);
  const seq = useRef(0);

  const paragraphs = useMemo(() => new Map<string, Paragraph>(script.version.paragraphs.map((p) => [p.id, p] as const)), [script.version.paragraphs]);
  const entityList = useMemo(() => entities.data ?? [], [entities.data]);
  const characters = useMemo(() => entityList.filter((e) => e.type === 'character'), [entityList]);
  const locations = useMemo(() => entityList.filter((e) => e.type === 'location'), [entityList]);

  const aliasLabel = useCallback(
    (alias: string) => {
      const e = entityList.find((x) => x.alias === alias);
      return e ? `${alias} ${e.name}` : `${alias}（不在名单中）`;
    },
    [entityList],
  );

  const locate = useCallback<WorkspaceValue['locate']>(
    (anchor) => {
      const pid = locateParagraph(script.version.paragraphs, anchor, script.version.id);
      if (!pid) {
        setNotice('当前剧本版本里找不到这段引用。');
        return;
      }
      seq.current += 1;
      setHighlight({ paragraphId: pid, quote: anchor?.quote.trim() ? anchor.quote : null, seq: seq.current });
    },
    [script.version],
  );

  const aiGate = useMemo(() => ({ enabled: ai.enabled, reason: ai.reason }), [ai.enabled, ai.reason]);
  const providerHost = hostOf(providers.data?.text?.base_url);

  const ws = useMemo<WorkspaceValue>(
    () => ({
      project,
      script,
      paragraphs,
      entities: entityList,
      characters,
      locations,
      aliasLabel,
      ai: aiGate,
      providerHost,
      highlight,
      locate,
      openEditor: (shot) => setEditor({ mode: 'edit', shot }),
      openCreate: (scene) => setEditor({ mode: 'create', scene }),
      openDraft: setDraftId,
      openRevisions: setRevisionsOf,
      askReason: setReason,
      notify: setNotice,
    }),
    [project, script, paragraphs, entityList, characters, locations, aliasLabel, aiGate, providerHost, highlight, locate],
  );

  const grouped = useMemo(() => groupShotsByScene(shots.data ?? []), [shots.data]);
  const sceneIds = useMemo(() => new Set(script.scenes.map((s) => s.id)), [script.scenes]);
  const orphans = useMemo(() => (shots.data ?? []).filter((s) => !s.archived && !sceneIds.has(s.scene_id)), [shots.data, sceneIds]);
  const relinkCount = useMemo(() => (shots.data ?? []).filter((s) => !s.archived && s.needs_relink).length, [shots.data]);
  const liveCount = useMemo(() => (shots.data ?? []).filter((s) => !s.archived).length, [shots.data]);

  const pendingBySceneId = useMemo(() => {
    const m = new Map<string, ShotDraft>();
    const list = [...(drafts.data ?? [])].filter((d) => d.kind === 'breakdown' && d.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const d of list) {
      const sid = draftSceneId(d);
      if (sid) m.set(sid, d); // newest wins
    }
    return m;
  }, [drafts.data]);

  const versionNo = useMemo(() => {
    const list = versions.data ?? [];
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const i = sorted.findIndex((v) => v.id === script.version.id);
    return { n: i >= 0 ? i + 1 : null, total: list.length };
  }, [versions.data, script.version.id]);

  const jumpToScene = useCallback((scene: Scene) => {
    const el = document.getElementById(sceneDomId(scene.id));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, []);

  const v = script.version;

  return (
    <WorkspaceContext.Provider value={ws}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <FileText aria-hidden className="size-5 text-ink-2" />
              剧本与镜头
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
              <span className="min-w-0 break-all">{v.source_name}</span>
              <Tag>{versionNo.n ? `第 ${versionNo.n} 版${versionNo.total > 1 ? ` / 共 ${versionNo.total} 版` : ''}` : '当前版本'}</Tag>
              <span className="text-ink-3">{SCRIPT_FORMAT_LABEL[v.format]}</span>
              <span className="text-ink-3 tabular-nums">{new Date(v.created_at).toLocaleString('zh-CN')}</span>
              <span className="font-mono text-[11.5px] text-ink-3" title="内容哈希">
                {v.content_hash.slice(0, 8)}
              </span>
              <span className="text-ink-3 tabular-nums">
                {script.scenes.length} 场 · {liveCount} 镜
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {relinkCount > 0 ? (
              <Button onClick={() => setRelinkOnly((r) => !r)} aria-pressed={relinkOnly} className={relinkOnly ? 'border-warn bg-warn-bg text-warn' : 'border-warn-rule text-warn'}>
                {relinkOnly ? '显示全部镜头' : `${relinkCount} 个镜头待重新关联`}
              </Button>
            ) : null}
            <Button onClick={onImportNew}>
              <Upload aria-hidden className="size-3.5" />
              导入新版本
            </Button>
          </div>
        </div>

        {notice ? (
          <div role="status" className="flex items-start gap-2 rounded-sheet border border-rule bg-sheet px-3 py-2 text-[13px] text-ink">
            <span className="min-w-0 flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-sheet-sunk hover:text-ink" aria-label="关闭提示">
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        ) : null}

        {!ai.enabled && ai.reason ? (
          <Note>
            {ai.reason}{' '}
            <a href="#/settings" className="text-focus underline underline-offset-2">
              前往设置
            </a>
          </Note>
        ) : null}

        {entities.isError ? <ErrorNotice error={entities.error} /> : null}
        {entities.data ? <EntitiesPanel onOpenEntityDraft={setEntityDraftId} /> : entities.isPending ? <Spinner label="正在读取角色…" /> : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <section aria-label="剧本原文" className="min-w-0 rounded-sheet border border-rule bg-sheet lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-rule bg-sheet/95 px-3 py-2">
              <h2 className="text-[13px] font-semibold text-ink">剧本原文</h2>
              <span className="text-xs text-ink-3 tabular-nums">{v.paragraphs.length} 段</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-2 py-2 lg:max-h-none lg:overflow-visible">
              <ScriptPane paragraphs={v.paragraphs} scenes={script.scenes} highlight={highlight} onHeadingClick={jumpToScene} />
            </div>
          </section>

          <div className="flex min-w-0 flex-col gap-3">
            {shots.isPending ? <Spinner label="正在读取镜头…" /> : null}
            {shots.isError ? (
              <div className="flex flex-col items-start gap-2">
                <ErrorNotice error={shots.error} />
                <Button onClick={() => void shots.refetch()}>重试</Button>
              </div>
            ) : null}
            {shots.data
              ? script.scenes.map((scene) => (
                  <SceneSection key={scene.id} scene={scene} shots={grouped.get(scene.id) ?? []} pendingDraft={pendingBySceneId.get(scene.id) ?? null} relinkOnly={relinkOnly} />
                ))
              : null}
            {orphans.length > 0 ? (
              <Note tone="warn">
                有 {orphans.length} 个镜头所属的场景不在当前剧本版本中（{orphans.map((s) => s.code).join('、')}），这里暂不显示，数据仍然保留。
              </Note>
            ) : null}
            {script.scenes.length === 0 ? <Note tone="warn">当前版本没有场景。导入新版本时，在预览里把场景标题行标出来。</Note> : null}
          </div>
        </div>
      </div>

      {editor ? <ShotEditor key={editor.mode === 'edit' ? editor.shot.id : `new-${editor.scene.id}`} target={editor} onClose={() => setEditor(null)} /> : null}
      {draftId ? <DraftDiffDialog draftId={draftId} onClose={() => setDraftId(null)} /> : null}
      {entityDraftId ? <EntityDraftDialog draftId={entityDraftId} onClose={() => setEntityDraftId(null)} /> : null}
      {revisionsOf ? <RevisionsDialog shot={revisionsOf} onClose={() => setRevisionsOf(null)} /> : null}
      {reason ? <ReasonDialog request={reason} onClose={() => setReason(null)} /> : null}
    </WorkspaceContext.Provider>
  );
}
