import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import type { Project } from '@storyscript/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api.ts';
import {
  bootstrapSession,
  isNoTeam,
  isSessionExpired,
  readTokenFromHash,
  resetNoTeam,
  resetSessionExpired,
  subscribeNoTeam,
  subscribeSessionExpired,
  type BootResult,
} from './lib/session.ts';
import { takeJoinFromLocation } from './lib/join.ts';
import { keys, useCloseProject, useCurrentProject, useHealth } from './lib/queries.ts';
import { useCollabSync } from './lib/collab.ts';
import { usePasteOpen } from './lib/queries-paste.ts';
import { useView } from './lib/route.ts';
import { isStage, type StageId } from './lib/stages.ts';
import { resetSaveState } from './lib/saveStatus.ts';
import { DemoBanner } from './components/DemoBanner.tsx';
import { ErrorNotice } from './components/ErrorNotice.tsx';
import { MentionsBell } from './components/MentionsBell.tsx';
import { AccountMenu } from './components/AccountMenu.tsx';
import { AuthScreen, GroupScreen } from './components/AccountScreens.tsx';
import { ConnectingScreen, SessionExpiredScreen, UnreachableScreen } from './components/FullScreenNotice.tsx';
import { PageBar } from './components/PageBar.tsx';
import { ActivityLine, PresenceStrip } from './components/PresenceStrip.tsx';
import { TitleBar } from './components/TitleBar.tsx';
import { Button, Spinner } from './components/ui.tsx';
import { HomeView } from './views/HomeView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { HostedProjectsView } from './views/HostedProjectsView.tsx';
import { PlanView } from './views/plan/PlanView.tsx';

// The script workspace is the heaviest page; it loads as its own chunk.
const ScriptView = lazy(() => import('./views/ScriptView.tsx').then((m) => ({ default: m.ScriptView })));
const SetView = lazy(() => import('./views/set/SetView.tsx').then((m) => ({ default: m.SetView })));
const MediaView = lazy(() => import('./views/media/MediaView.tsx').then((m) => ({ default: m.MediaView })));
const BoardsView = lazy(() => import('./views/boards/BoardsPage.tsx'));
const DeliverView = lazy(() => import('./views/deliver/DeliverView.tsx'));
const PasteDialog = lazy(() => import('./components/PasteDialog.tsx').then((m) => ({ default: m.PasteDialog })));

// One bootstrap per attempt, shared across StrictMode's double effects so the
// token is posted once.
let boot: { attempt: number; promise: Promise<BootResult> } | null = null;

function startBootstrap(attempt: number): Promise<BootResult> {
  if (!boot || boot.attempt !== attempt) {
    boot = { attempt, promise: bootstrapSession({ client: api, location: window.location, history: window.history }) };
  }
  return boot.promise;
}

type BootState = { kind: 'checking' } | BootResult;

export function App() {
  const qc = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootState>({ kind: 'checking' });
  const expired = useSyncExternalStore(subscribeSessionExpired, isSessionExpired);
  const noTeam = useSyncExternalStore(subscribeNoTeam, isNoTeam);
  // hosted server: a group join link (#join=…) is kept until the person is signed in
  const [joinLinks, setJoinLinks] = useState(() => (takeJoinFromLocation(window.location, window.history) ? 1 : 0));

  /** Start over after signing in or changing group: the project behind every query changes. */
  const restart = () => {
    qc.clear();
    resetSessionExpired();
    resetNoTeam();
    setState({ kind: 'checking' });
    setAttempt((a) => a + 1);
  };

  useEffect(() => {
    let live = true;
    void startBootstrap(attempt).then((r) => {
      if (!live) return;
      if (r.kind === 'ready') {
        qc.setQueryData(keys.health, r.health);
        // After re-authenticating, drop results fetched under the old session.
        if (attempt > 0) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== keys.health[0] });
      }
      setState(r);
    });
    return () => {
      live = false;
    };
  }, [attempt, qc]);

  // A new terminal link (or group join link) pasted into this tab only changes the hash (no reload).
  useEffect(() => {
    const onHash = () => {
      if (takeJoinFromLocation(window.location, window.history)) {
        setJoinLinks((n) => n + 1);
        window.dispatchEvent(new Event('ssm-join-link'));
        return;
      }
      if (readTokenFromHash(window.location.hash) === null) return;
      resetSessionExpired();
      setState({ kind: 'checking' });
      setAttempt((a) => a + 1);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (expired || state.kind === 'expired') return <SignedOut key={joinLinks} onSignedIn={restart} />;
  if (state.kind === 'checking') return <ConnectingScreen />;
  if (state.kind === 'no-team' || noTeam) return <GroupScreen key={joinLinks} onJoined={restart} />;
  if (state.kind === 'unreachable') {
    return (
      <UnreachableScreen
        error={state.error}
        onRetry={() => {
          setState({ kind: 'checking' });
          setAttempt((a) => a + 1);
        }}
      />
    );
  }
  return <Workbench onGroupChanged={restart} />;
}

/** No session: a hosted server offers sign-in and registration; the local app points at the terminal link. */
function SignedOut({ onSignedIn }: { onSignedIn: () => void }) {
  const site = useQuery({ queryKey: ['site'], queryFn: ({ signal }) => api.call('site', undefined, { signal }), retry: false });
  if (site.isPending) return <ConnectingScreen />;
  if (site.data?.hosted) return <AuthScreen siteName={site.data.name} onSignedIn={onSignedIn} />;
  return <SessionExpiredScreen />;
}

function Workbench({ onGroupChanged }: { onGroupChanged: () => void }) {
  const health = useHealth();
  const project = useCurrentProject();
  const close = useCloseProject();
  const view = useView();

  const current = project.data ?? null;
  // S5a: 粘贴整理 opens over any page of an open project
  const pasteOpen = usePasteOpen().open && current !== null;

  // S4a: teammates' changes arrive by polling while a project is open (hosted and local); the tab says which page it is on
  useCollabSync(view ?? (current ? 'script' : 'home'), current !== null);

  useEffect(() => {
    document.title = current ? `${current.name} - StoryScript-Mov` : 'StoryScript-Mov';
  }, [current]);

  // `page` keys the fade-in: it changes exactly when the main workspace changes.
  let page: string;
  let body;
  if (view === 'settings') {
    page = 'settings';
    body = <SettingsView />;
  } else if (view === 'projects' && health.data?.hosted) {
    // hosted: the groups one is in, one project each
    page = 'projects';
    body = <HostedProjectsView onGroupChanged={onGroupChanged} />;
  } else if (project.isPending) {
    page = 'loading';
    body = (
      <div className="flex h-full items-center justify-center">
        <Spinner label="正在读取项目…" />
      </div>
    );
  } else if (project.isError) {
    page = 'error';
    body = (
      <div className="mx-auto flex max-w-[520px] flex-col items-start gap-3 px-4 py-10">
        <ErrorNotice error={project.error} />
        <Button onClick={() => void project.refetch()}>重试</Button>
      </div>
    );
  } else if (!current) {
    page = 'home';
    body = <HomeView />;
  } else {
    const stage: StageId = isStage(view) ? view : 'script';
    page = stage;
    body = <StagePage stage={stage} project={current} />;
  }

  return (
    <div className="flex h-dvh flex-col bg-graphite-950 print:block print:h-auto print:bg-print-paper">
      <TitleBar
        project={current}
        view={view}
        account={health.data?.hosted ? <AccountMenu onGroupChanged={onGroupChanged} /> : null}
        alerts={health.data?.hosted ? <MentionsBell /> : null}
        presence={
          health.data?.hosted ? (
            <>
              <ActivityLine />
              <PresenceStrip />
            </>
          ) : null
        }
        switching={close.isPending}
        onSwitchProject={() =>
          close.mutate(undefined, {
            onSuccess: () => resetSaveState(),
          })
        }
      />
      {close.isError ? (
        <div className="px-2 pt-2 print:hidden">
          <ErrorNotice error={close.error} />
        </div>
      ) : null}
      <main className="relative min-h-0 flex-1 overflow-auto print:overflow-visible">
        <div key={page} className="h-full animate-page-in motion-reduce:animate-none print:h-auto">
          {body}
        </div>
      </main>
      {health.data?.demo ? <DemoBanner /> : null}
      <PageBar project={current} view={view} />
      {pasteOpen ? (
        <Suspense fallback={null}>
          <PasteDialog />
        </Suspense>
      ) : null}
    </div>
  );
}

/** One workflow stage; the heavier views load on first visit. */
function StagePage({ stage, project }: { stage: StageId; project: Project }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner label="正在加载…" />
        </div>
      }
    >
      <StageView stage={stage} project={project} />
    </Suspense>
  );
}

function StageView({ stage, project }: { stage: StageId; project: Project }) {
  switch (stage) {
    case 'script':
      return <ScriptView project={project} />;
    case 'boards':
      return <BoardsView />;
    case 'plan':
      return <PlanView />;
    case 'set':
      return <SetView />;
    case 'media':
      return <MediaView />;
    case 'deliver':
      return <DeliverView />;
  }
}
