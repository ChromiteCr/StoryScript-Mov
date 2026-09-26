import { MutationCache, QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProjectInput, CurrentScript, Entity, Job, Project, Scene, Shot, ShotDraft } from '@storyscript/contracts';
import { api, isApiClientError, isUnauthorized, type InputOf } from './api.ts';
import { describeError } from './errors.ts';
import { isTerminalJob, resetTrackedJobs } from './jobs.ts';
import { markSaved, markSaveFailed, markSaving } from './saveStatus.ts';
import { markSessionExpired } from './session.ts';
import { mergeShots, reorderLocally } from './shots.ts';
import { navigate } from './route.ts';

export const keys = {
  health: ['health'] as const,
  recent: ['projects', 'recent'] as const,
  project: ['project'] as const,
  /** active (queued/running) jobs of the open project, for the page bar */
  jobs: ['jobs', 'active'] as const,
  // M3
  providers: ['settings', 'providers'] as const,
  script: ['script', 'current'] as const,
  scriptVersions: ['script', 'versions'] as const,
  entities: ['entities'] as const,
  shots: ['shots'] as const,
  shotRevisions: (id: string) => ['shot-revisions', id] as const,
  drafts: ['drafts'] as const,
  draft: (id: string) => ['drafts', id] as const,
  job: (id: string) => ['jobs', 'one', id] as const,
};

/** Query roots that belong to the open project; dropped when it changes. */
const PROJECT_SCOPED_ROOTS: ReadonlySet<string> = new Set(['script', 'entities', 'shots', 'shot-revisions', 'drafts', 'jobs']);

function dropProjectData(qc: QueryClient): void {
  qc.removeQueries({ predicate: (q) => PROJECT_SCOPED_ROOTS.has(String(q.queryKey[0])) });
  resetTrackedJobs();
}

function onAnyError(error: unknown): void {
  if (isUnauthorized(error)) markSessionExpired();
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onAnyError }),
    mutationCache: new MutationCache({ onError: onAnyError }),
    defaultOptions: {
      queries: {
        // Local server: only a dropped connection is worth one retry.
        retry: (count, error) => count < 1 && isApiClientError(error) && error.code === 'NETWORK_ERROR',
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
      mutations: { retry: false },
    },
  });
}

export function useHealth() {
  return useQuery({ queryKey: keys.health, queryFn: ({ signal }) => api.call('health', undefined, { signal }) });
}

export function useRecentProjects() {
  return useQuery({
    queryKey: keys.recent,
    queryFn: async ({ signal }) => {
      const list = await api.call('recentProjects', undefined, { signal });
      return [...list].sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    },
  });
}

/** Current project, or null when none is open. */
export function useCurrentProject() {
  return useQuery({
    queryKey: keys.project,
    queryFn: async ({ signal }): Promise<Project | null> => {
      try {
        return await api.call('currentProject', undefined, { signal });
      } catch (e) {
        if (isApiClientError(e) && e.code === 'NO_PROJECT_OPEN') return null;
        throw e;
      }
    },
  });
}

function useProjectOpened() {
  const qc = useQueryClient();
  return (project: Project) => {
    dropProjectData(qc);
    qc.setQueryData(keys.project, project);
    void qc.invalidateQueries({ queryKey: keys.recent });
    void qc.invalidateQueries({ queryKey: keys.health });
    navigate('script');
  };
}

export function useOpenProject() {
  const opened = useProjectOpened();
  return useMutation({ mutationFn: (dir: string) => api.call('openProject', { dir }), onSuccess: opened });
}

export function useCreateProject() {
  const opened = useProjectOpened();
  return useMutation({ mutationFn: (input: CreateProjectInput) => api.call('createProject', input), onSuccess: opened });
}

export function useCloseProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.call('closeProject'),
    onSuccess: () => {
      dropProjectData(qc);
      qc.setQueryData(keys.project, null);
      qc.removeQueries({ queryKey: keys.jobs });
      void qc.invalidateQueries({ queryKey: keys.recent });
      void qc.invalidateQueries({ queryKey: keys.health });
      navigate(null);
    },
  });
}

/**
 * Active background jobs of the open project, polled once a second (FR-11).
 * Polling stops after an error (e.g. a server without the jobs route yet) and
 * resumes on the next explicit refetch.
 */
export function useActiveJobs(enabled: boolean) {
  return useQuery({
    queryKey: keys.jobs,
    queryFn: ({ signal }) => api.call('listActiveJobs', undefined, { signal }),
    enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => (query.state.status === 'error' ? false : 1000),
  });
}

/** Native folder dialog on the server machine; resolves null when cancelled. */
export function useChooseFolder() {
  return useMutation({ mutationFn: async () => (await api.call('chooseFolder')).path });
}

// ====================================================================== M3 ==

/**
 * Wraps a write so the top bar's save indicator follows it (FR-01: "已保存"
 * only after the server committed).
 */
async function saving<R>(run: () => Promise<R>): Promise<R> {
  markSaving();
  try {
    const r = await run();
    markSaved();
    return r;
  } catch (e) {
    markSaveFailed(describeError(e).title);
    throw e;
  }
}

// ---------------------------------------------------------------- settings --

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: ({ signal }) => api.call('getProviders', undefined, { signal }) });
}

export function useSaveTextProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'saveTextProvider'>) => api.call('saveTextProvider', input),
    onSuccess: (view) => {
      qc.setQueryData(keys.providers, view);
      void qc.invalidateQueries({ queryKey: keys.health });
    },
  });
}

export function useTestTextProvider() {
  return useMutation({ mutationFn: () => api.call('testTextProvider') });
}

export interface AiGate {
  enabled: boolean;
  /** why AI buttons are disabled; null when enabled */
  reason: string | null;
  /** --demo: AI routes replay recorded outputs and send nothing */
  demo: boolean;
}

/** Pure part of useAiGate (tested). */
export function aiGateOf(health: { text_provider_configured: boolean; demo: boolean } | undefined): AiGate {
  if (!health) return { enabled: false, reason: '正在检测模型配置…', demo: false };
  // In demo mode the server answers AI routes from fixtures/replay without a key.
  if (health.demo) return { enabled: true, reason: null, demo: true };
  if (health.text_provider_configured) return { enabled: true, reason: null, demo: false };
  return { enabled: false, reason: '未配置文本模型：在"设置 → 模型"中填写后可用。手工流程不受影响。', demo: false };
}

/** AI buttons work only with a configured text provider (SPEC §1: 无 key 可用). */
export function useAiGate(): AiGate {
  return aiGateOf(useHealth().data);
}

// ------------------------------------------------------------------ script --

export function useCurrentScript() {
  return useQuery({ queryKey: keys.script, queryFn: ({ signal }) => api.call('currentScript', undefined, { signal }) });
}

export function useScriptVersions() {
  return useQuery({ queryKey: keys.scriptVersions, queryFn: ({ signal }) => api.call('scriptVersions', undefined, { signal }) });
}

export function usePreviewScript() {
  return useMutation({ mutationFn: (input: InputOf<'previewScript'>) => api.call('previewScript', input) });
}

export function useImportScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'importScript'>) => saving(() => api.call('importScript', input)),
    onSuccess: (r) => {
      const next: CurrentScript = { version: r.version, scenes: r.scenes };
      qc.setQueryData(keys.script, next);
      void qc.invalidateQueries({ queryKey: keys.scriptVersions });
      void qc.invalidateQueries({ queryKey: keys.shots });
      void qc.invalidateQueries({ queryKey: keys.drafts });
    },
  });
}

export function useUpdateScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'updateScene'> }) =>
      saving(() => api.call('updateScene', input, { params: { id } })),
    onSuccess: (scene: Scene) => {
      qc.setQueryData<CurrentScript | null>(keys.script, (old) =>
        old ? { ...old, scenes: old.scenes.map((s) => (s.id === scene.id ? scene : s)) } : old,
      );
    },
  });
}

// ---------------------------------------------------------------- entities --

export function useEntities() {
  return useQuery({ queryKey: keys.entities, queryFn: ({ signal }) => api.call('listEntities', undefined, { signal }) });
}

function upsertEntity(qc: QueryClient, e: Entity): void {
  qc.setQueryData<Entity[]>(keys.entities, (old) => {
    if (!old) return [e];
    return old.some((x) => x.id === e.id) ? old.map((x) => (x.id === e.id ? e : x)) : [...old, e];
  });
}

export function useCreateEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'createEntity'>) => saving(() => api.call('createEntity', input)),
    onSuccess: (e) => upsertEntity(qc, e),
  });
}

export function useUpdateEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'updateEntity'> }) =>
      saving(() => api.call('updateEntity', input, { params: { id } })),
    onSuccess: (e) => upsertEntity(qc, e),
  });
}

export function useExtractEntities() {
  return useMutation({ mutationFn: () => api.call('extractEntities') });
}

export function useApplyEntityDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'applyEntityDraft'> }) =>
      saving(() => api.call('applyEntityDraft', input, { params: { id } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.entities });
      void qc.invalidateQueries({ queryKey: keys.drafts });
    },
  });
}

// ------------------------------------------------------------------- shots --

export function useShots() {
  return useQuery({ queryKey: keys.shots, queryFn: ({ signal }) => api.call('listShots', undefined, { signal }) });
}

function shotsUpdated(qc: QueryClient, updated: readonly Shot[]): void {
  // GET /shots lists live shots only; an archived one leaves the table.
  qc.setQueryData<Shot[]>(keys.shots, (old) => mergeShots(old, updated).filter((s) => !s.archived));
  for (const s of updated) void qc.invalidateQueries({ queryKey: keys.shotRevisions(s.id) });
}

export function useCreateShot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'createShot'>) => saving(() => api.call('createShot', input)),
    onSuccess: (shot) => shotsUpdated(qc, [shot]),
  });
}

export function useUpdateShot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'updateShot'> }) =>
      saving(() => api.call('updateShot', input, { params: { id } })),
    onSuccess: (shot) => shotsUpdated(qc, [shot]),
  });
}

export function useArchiveShot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'archiveShot'> }) =>
      saving(() => api.call('archiveShot', input, { params: { id } })),
    onSuccess: (shot) => shotsUpdated(qc, [shot]),
  });
}

export function useSetRequirement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'setRequirement'> }) =>
      saving(() => api.call('setRequirement', input, { params: { id } })),
    onSuccess: (shot) => shotsUpdated(qc, [shot]),
  });
}

export function useSetNarrativeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'setNarrativeOrder'>) => saving(() => api.call('setNarrativeOrder', input)),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.shots, exact: true });
      const prev = qc.getQueryData<Shot[]>(keys.shots);
      if (prev) qc.setQueryData<Shot[]>(keys.shots, reorderLocally(prev, input.shot_ids));
      return { prev };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.shots, ctx.prev);
      void qc.invalidateQueries({ queryKey: keys.shots, exact: true });
    },
    onSuccess: (shots) => qc.setQueryData<Shot[]>(keys.shots, (old) => mergeShots(old, shots)),
  });
}

export function useShotRevisions(id: string | null) {
  return useQuery({
    queryKey: keys.shotRevisions(id ?? ''),
    queryFn: ({ signal }) => api.call('shotRevisions', undefined, { signal, params: { id: id ?? '' } }),
    enabled: id !== null,
    staleTime: 0,
  });
}

// ------------------------------------------------------ breakdown & drafts --

export function useRequestBreakdown() {
  return useMutation({
    mutationFn: ({ sceneId, input }: { sceneId: string; input: InputOf<'requestBreakdown'> }) =>
      api.call('requestBreakdown', input, { params: { id: sceneId } }),
  });
}

export function useDrafts() {
  return useQuery({ queryKey: keys.drafts, queryFn: ({ signal }) => api.call('listDrafts', undefined, { signal }) });
}

export function useDraft(id: string | null) {
  return useQuery({
    queryKey: keys.draft(id ?? ''),
    queryFn: ({ signal }) => api.call('getDraft', undefined, { signal, params: { id: id ?? '' } }),
    enabled: id !== null,
    staleTime: 0,
  });
}

export function useApplyBreakdown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'applyBreakdown'> }) =>
      saving(() => api.call('applyBreakdown', input, { params: { id } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.shots });
      void qc.invalidateQueries({ queryKey: keys.drafts });
    },
  });
}

export function useDiscardDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.call('discardDraft', undefined, { params: { id } }),
    onSuccess: (draft: ShotDraft) => {
      qc.setQueryData<ShotDraft[]>(keys.drafts, (old) => old?.map((d) => (d.id === draft.id ? draft : d)));
      void qc.invalidateQueries({ queryKey: keys.drafts });
    },
  });
}

// -------------------------------------------------------------------- jobs --

/** Polls a job once a second until it reaches a terminal status (FR-11). */
export function useJob(id: string | null) {
  return useQuery({
    queryKey: keys.job(id ?? ''),
    queryFn: ({ signal }) => api.call('getJob', undefined, { signal, params: { id: id ?? '' } }),
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false;
      const job: Job | undefined = q.state.data;
      return job && isTerminalJob(job) ? false : 1000;
    },
    refetchIntervalInBackground: true,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.call('cancelJob', undefined, { params: { id } }),
    onSuccess: (job) => qc.setQueryData(keys.job(job.id), job),
  });
}
