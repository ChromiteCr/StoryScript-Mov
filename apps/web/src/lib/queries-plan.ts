import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Job, PlanDetail, Resource, Setup } from '@storyscript/contracts';
import { api, isApiClientError, type InputOf } from './api.ts';
import { refetchOnConflict, useProviders as useEffectiveProviders } from './queries.ts';
import { markSaveFailed, markSaved, markSaving } from './saveStatus.ts';

/**
 * Plan page data (FR-06). Every key lives under ['plan', …] so this module
 * never collides with the script page's cache; staleTime 0 so coming back
 * to the page always refetches (other pages edit shots and entities).
 * Writes report to the save indicator only after the server committed.
 */

export const planKeys = {
  all: ['plan'] as const,
  resources: ['plan', 'resources'] as const,
  setups: ['plan', 'setups'] as const,
  constraints: ['plan', 'constraints'] as const,
  plans: ['plan', 'plans'] as const,
  plan: (id: string) => ['plan', 'plans', id] as const,
  entities: ['plan', 'entities'] as const,
  shots: ['plan', 'shots'] as const,
  script: ['plan', 'script'] as const,
  job: (id: string) => ['plan', 'job', id] as const,
  draft: (id: string) => ['plan', 'draft', id] as const,
};

const live = { staleTime: 0 } as const;

export function useResources() {
  return useQuery({ queryKey: planKeys.resources, queryFn: ({ signal }) => api.call('listResources', undefined, { signal }), ...live });
}

export function useSetups() {
  return useQuery({ queryKey: planKeys.setups, queryFn: ({ signal }) => api.call('listSetups', undefined, { signal }), ...live });
}

export function useConstraints() {
  return useQuery({ queryKey: planKeys.constraints, queryFn: ({ signal }) => api.call('listConstraints', undefined, { signal }), ...live });
}

export function usePlans() {
  return useQuery({ queryKey: planKeys.plans, queryFn: ({ signal }) => api.call('listPlans', undefined, { signal }), ...live });
}

export function usePlanDetail(id: string | null) {
  return useQuery({
    queryKey: planKeys.plan(id ?? 'none'),
    queryFn: ({ signal }) => api.call('getPlan', undefined, { signal, params: { id: id! } }),
    enabled: id !== null,
    ...live,
  });
}

export function useEntities() {
  return useQuery({ queryKey: planKeys.entities, queryFn: ({ signal }) => api.call('listEntities', undefined, { signal }), ...live });
}

export function useShots() {
  return useQuery({ queryKey: planKeys.shots, queryFn: ({ signal }) => api.call('listShots', undefined, { signal }), ...live });
}

export function useCurrentScript() {
  return useQuery({ queryKey: planKeys.script, queryFn: ({ signal }) => api.call('currentScript', undefined, { signal }), ...live });
}

/**
 * Provider view (host only, never the key) for the "what will be sent"
 * confirmation: the model this member's requests actually use (hosted: the
 * group's, or their own when they chose it).
 */
export function useProviders(enabled: boolean) {
  return useEffectiveProviders(enabled);
}

// ---------------------------------------------------------------- writes ---

async function saving<T>(fn: () => Promise<T>): Promise<T> {
  markSaving();
  try {
    const out = await fn();
    markSaved();
    return out;
  } catch (e) {
    markSaveFailed(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Inputs changed: every plan may be stale now, lists must refetch. */
function inputsChanged(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: planKeys.all });
}

function planChanged(qc: QueryClient, detail: PlanDetail) {
  qc.setQueryData(planKeys.plan(detail.plan.id), detail);
  void qc.invalidateQueries({ queryKey: planKeys.plans, exact: true });
}

/** A 409 on a plan write means someone else moved it: refetch so the next try uses the new revision. */
function onPlanError(qc: QueryClient, id: string, e: unknown) {
  if (isApiClientError(e) && e.code === 'REVISION_CONFLICT') void qc.invalidateQueries({ queryKey: planKeys.plan(id) });
}

/**
 * Create (id null) or update a resource. An update names the revision the
 * edit started from (S4a): a teammate's newer save answers 409 and the plan
 * queries refetch it.
 */
export function useSaveResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string | null; input: InputOf<'createResource'>; expected_revision?: number }) =>
      saving(() =>
        v.id
          ? api.call('updateResource', { ...v.input, expected_revision: v.expected_revision }, { params: { id: v.id } })
          : api.call('createResource', v.input),
      ),
    onSuccess: (saved: Resource) => {
      qc.setQueryData<Resource[]>(planKeys.resources, (old) => old?.map((x) => (x.id === saved.id ? saved : x)));
      inputsChanged(qc);
    },
    onError: refetchOnConflict(qc, planKeys.all),
  });
}

export function useDeleteResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => saving(() => api.call('deleteResource', undefined, { params: { id } })),
    onSuccess: () => inputsChanged(qc),
  });
}

export function useDeriveSetups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'deriveSetups'>) => saving(() => api.call('deriveSetups', input)),
    onSuccess: () => inputsChanged(qc),
  });
}

export function useCreateSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'createSetup'>) => saving(() => api.call('createSetup', input)),
    onSuccess: () => inputsChanged(qc),
  });
}

export function useUpdateSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; input: InputOf<'updateSetup'> }) => saving(() => api.call('updateSetup', v.input, { params: { id: v.id } })),
    onSuccess: (saved: Setup) => {
      // the new revision is in the cache before the refetch lands, so the next edit names it
      qc.setQueryData<Setup[]>(planKeys.setups, (old) => old?.map((x) => (x.id === saved.id ? saved : x)));
      inputsChanged(qc);
    },
    onError: refetchOnConflict(qc, planKeys.all),
  });
}

export function useDeleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => saving(() => api.call('deleteSetup', undefined, { params: { id } })),
    onSuccess: () => inputsChanged(qc),
  });
}

export function useCreateConstraint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'createConstraint'>) => saving(() => api.call('createConstraint', input)),
    onSuccess: () => inputsChanged(qc),
  });
}

export function useDeleteConstraint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => saving(() => api.call('deleteConstraint', undefined, { params: { id } })),
    onSuccess: () => inputsChanged(qc),
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<'createPlan'>) => saving(() => api.call('createPlan', input)),
    onSuccess: (detail) => planChanged(qc, detail),
  });
}

export type PlanWrite =
  | { kind: 'recompute'; id: string; revision: number }
  | { kind: 'reorder'; id: string; revision: number; order: string[] }
  | { kind: 'approve'; id: string; revision: number }
  | { kind: 'adopt'; id: string; revision: number; draft_id: string };

/** recompute / reorder / approve / adopt: all carry expected_revision and return PlanDetail. */
export function usePlanWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (w: PlanWrite) =>
      saving(() => {
        const params = { id: w.id };
        switch (w.kind) {
          case 'recompute':
            return api.call('recomputePlan', { expected_revision: w.revision }, { params });
          case 'reorder':
            return api.call('reorderPlan', { expected_revision: w.revision, order: w.order }, { params });
          case 'approve':
            return api.call('approvePlan', { expected_revision: w.revision }, { params });
          case 'adopt':
            return api.call('adoptSuggestion', { expected_revision: w.revision, draft_id: w.draft_id }, { params });
        }
      }),
    onSuccess: (detail) => planChanged(qc, detail),
    onError: (e, w) => onPlanError(qc, w.id, e),
  });
}

export function useSuggestOrder() {
  return useMutation({ mutationFn: (planId: string) => api.call('suggestOrder', undefined, { params: { id: planId } }) });
}

const inFlight = (j: Job | undefined) => j === undefined || j.status === 'queued' || j.status === 'running';

/** One job, polled once a second until it settles (FR-11). */
export function useJob(id: string | null) {
  return useQuery({
    queryKey: planKeys.job(id ?? 'none'),
    queryFn: ({ signal }) => api.call('getJob', undefined, { signal, params: { id: id! } }),
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (query) => (query.state.status === 'error' || !inFlight(query.state.data) ? false : 1000),
  });
}

export function useDraft(id: string | null) {
  return useQuery({
    queryKey: planKeys.draft(id ?? 'none'),
    queryFn: ({ signal }) => api.call('getDraft', undefined, { signal, params: { id: id! } }),
    enabled: id !== null,
  });
}
