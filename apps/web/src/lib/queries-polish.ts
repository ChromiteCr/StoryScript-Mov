import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type InputOf } from './api.ts';
import { describeError } from './errors.ts';
import { keys, shotsUpdated } from './queries.ts';
import { markSaved, markSaveFailed, markSaving } from './saveStatus.ts';

/**
 * S3a polish. The request starts a job (the caller follows it with
 * trackJob(POLISH_SLOT, job_id)); applying writes the ticked items in place,
 * so the returned shots replace their rows in the shots cache the way every
 * other shot write does, and the drafts list is refreshed (the draft is now
 * applied).
 */

export { POLISH_SLOT } from './jobs.ts';

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

export function useRequestPolish() {
  return useMutation({
    mutationFn: (input: InputOf<'requestPolish'>) => api.call('requestPolish', input),
  });
}

export function useApplyPolish() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: InputOf<'applyPolish'> }) => saving(() => api.call('applyPolish', input, { params: { id } })),
    onSuccess: (result) => {
      shotsUpdated(qc, result.updated);
      void qc.invalidateQueries({ queryKey: keys.drafts });
    },
  });
}
