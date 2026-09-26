import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api.ts';
import {
  bootstrapSession,
  isSessionExpired,
  readTokenFromHash,
  resetSessionExpired,
  subscribeSessionExpired,
  type BootResult,
} from './lib/session.ts';
import { keys, useCloseProject, useCurrentProject, useHealth } from './lib/queries.ts';
import { useView } from './lib/route.ts';
import { isStage, type StageId } from './lib/stages.ts';
import { resetSaveState } from './lib/saveStatus.ts';
import { DemoBanner } from './components/DemoBanner.tsx';
import { ErrorNotice } from './components/ErrorNotice.tsx';
import { ConnectingScreen, SessionExpiredScreen, UnreachableScreen } from './components/FullScreenNotice.tsx';
import { PageBar } from './components/PageBar.tsx';
import { TitleBar } from './components/TitleBar.tsx';
import { Button, Spinner } from './components/ui.tsx';
import { ComingSoonView } from './views/ComingSoonView.tsx';
import { HomeView } from './views/HomeView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { StageOutlineView } from './views/StageOutlineView.tsx';
import { PlanView } from './views/plan/PlanView.tsx';

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

  // A new terminal link pasted into this tab only changes the hash (no reload).
  useEffect(() => {
    const onHash = () => {
      if (readTokenFromHash(window.location.hash) === null) return;
      resetSessionExpired();
      setState({ kind: 'checking' });
      setAttempt((a) => a + 1);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (expired || state.kind === 'expired') return <SessionExpiredScreen />;
  if (state.kind === 'checking') return <ConnectingScreen />;
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
  return <Workbench />;
}

function Workbench() {
  const health = useHealth();
  const project = useCurrentProject();
  const close = useCloseProject();
  const view = useView();

  const current = project.data ?? null;

  useEffect(() => {
    document.title = current ? `${current.name} - StoryScript-Mov` : 'StoryScript-Mov';
  }, [current]);

  // `page` keys the fade-in: it changes exactly when the main workspace changes.
  let page: string;
  let body;
  if (view === 'settings') {
    page = 'settings';
    body = <SettingsView />;
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
    body = <StagePage stage={stage} />;
  }

  return (
    <div className="flex h-dvh flex-col bg-graphite-950 print:block print:h-auto">
      <TitleBar
        project={current}
        view={view}
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
      <main className="min-h-0 flex-1 overflow-auto print:overflow-visible">
        <div key={page} className="h-full animate-page-in motion-reduce:animate-none print:h-auto">
          {body}
        </div>
      </main>
      {health.data?.demo ? <DemoBanner /> : null}
      <PageBar project={current} view={view} />
    </div>
  );
}

/** One workflow stage. Script keeps its placeholder until the script page lands. */
function StagePage({ stage }: { stage: StageId }) {
  if (stage === 'script') return <ComingSoonView view="script" />;
  if (stage === 'plan') return <PlanView />;
  return <StageOutlineView stage={stage} />;
}
