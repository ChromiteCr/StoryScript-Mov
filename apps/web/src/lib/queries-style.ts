import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StyleCardInput, StyleDefaults } from '@storyscript/contracts';
import { api } from './api.ts';
import { describeError } from './errors.ts';
import { keys } from './queries.ts';
import { markSaved, markSaveFailed, markSaving } from './saveStatus.ts';

/**
 * S3 style library: the built-in and the group's own cards plus the group's
 * defaults. Every key lives under ['styles', …] (dropped when the project
 * changes, see queries.ts PROJECT_SCOPED_ROOTS); staleTime 0 so the breakdown
 * form and the library always see the latest defaults.
 */

export const styleKeys = {
  all: ['styles'] as const,
  library: ['styles', 'library'] as const,
};

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

export function useStyles() {
  return useQuery({
    queryKey: styleKeys.library,
    queryFn: ({ signal }) => api.call('getStyles', undefined, { signal }),
    staleTime: 0,
  });
}

function useRefreshStyles() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: styleKeys.all });
}

export function useCreateStyle() {
  const refresh = useRefreshStyles();
  return useMutation({
    mutationFn: (input: StyleCardInput) => saving(() => api.call('createStyle', input)),
    onSuccess: refresh,
  });
}

export function useUpdateStyle() {
  const refresh = useRefreshStyles();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: StyleCardInput }) => saving(() => api.call('updateStyle', input, { params: { id } })),
    onSuccess: refresh,
  });
}

export function useDeleteStyle() {
  const refresh = useRefreshStyles();
  return useMutation({
    mutationFn: (id: string) => saving(() => api.call('deleteStyle', undefined, { params: { id } })),
    onSuccess: refresh,
  });
}

export function useSaveStyleDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StyleDefaults) => saving(() => api.call('saveStyleDefaults', input)),
    onSuccess: (library) => qc.setQueryData(styleKeys.library, library),
  });
}

/** Starts the research job; the caller follows it with trackJob(STYLE_RESEARCH_SLOT, job_id). */
export function useResearchStyle() {
  return useMutation({
    mutationFn: (input: { reference: string; notes: string | null }) => api.call('researchStyle', input),
  });
}

export function useSaveResearchedStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, input }: { draftId: string; input: StyleCardInput }) =>
      saving(() => api.call('saveResearchedStyle', input, { params: { id: draftId } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: styleKeys.all });
      void qc.invalidateQueries({ queryKey: keys.drafts });
    },
  });
}
