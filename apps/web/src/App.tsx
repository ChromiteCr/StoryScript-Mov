import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
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
import { resetSaveState } from './lib/saveStatus.ts';
import { DemoBanner } from './components/DemoBanner.tsx';
import { ErrorNotice } from './components/ErrorNotice.tsx';
import { ConnectingScreen, SessionExpiredScreen, UnreachableScreen } from './components/FullScreenNotice.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Button, Spinner } from './components/ui.tsx';
import { ComingSoonView } from './views/ComingSoonView.tsx';
import { HomeView } from './views/HomeView.tsx';
import { SettingsView } from './views/SettingsView.tsx';

// The script workspace is the heaviest view; load it as its own chunk.
const ScriptView = lazy(() => import('./views/ScriptView.tsx').then((m) => ({ default: m.ScriptView })));

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

  let body;
  if (view === 'settings') {
    body = <SettingsView />;
  } else if (project.isPending) {
    body = <Spinner label="正在读取项目…" />;
  } else if (project.isError) {
    body = (
      <div className="flex max-w-[520px] flex-col items-start gap-3">
        <ErrorNotice error={project.error} />
        <Button onClick={() => void project.refetch()}>重试</Button>
      </div>
    );
  } else if (!current) {
    body = <HomeView />;
  } else if (view === null || view === 'script') {
    body = (
      <Suspense fallback={<Spinner label="正在加载…" />}>
        <ScriptView project={current} />
      </Suspense>
    );
  } else {
    body = <ComingSoonView view={view} />;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {health.data?.demo ? <DemoBanner /> : null}
      <TopBar
        project={current}
        view={current ? (view ?? 'script') : view}
        switching={close.isPending}
        onSwitchProject={() =>
          close.mutate(undefined, {
            onSuccess: () => resetSaveState(),
          })
        }
      />
      {close.isError ? (
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-4 sm:px-6">
          <ErrorNotice error={close.error} />
        </div>
      ) : null}
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-6 sm:py-8">{body}</main>
    </div>
  );
}
