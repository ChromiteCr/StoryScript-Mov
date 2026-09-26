import { MutationCache, QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProjectInput, Project } from '@storyscript/contracts';
import { api, isApiClientError, isUnauthorized } from './api.ts';
import { markSessionExpired } from './session.ts';
import { navigate } from './route.ts';

export const keys = {
  health: ['health'] as const,
  recent: ['projects', 'recent'] as const,
  project: ['project'] as const,
};

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
      qc.setQueryData(keys.project, null);
      void qc.invalidateQueries({ queryKey: keys.recent });
      void qc.invalidateQueries({ queryKey: keys.health });
      navigate(null);
    },
  });
}

/** Native folder dialog on the server machine; resolves null when cancelled. */
export function useChooseFolder() {
  return useMutation({ mutationFn: async () => (await api.call('chooseFolder')).path });
}
