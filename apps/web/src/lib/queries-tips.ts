import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

/**
 * S5c 镜头拍摄提示: the tips of every live shot (a first guess from the shot's
 * fields, or the model's per scene) under ['tips'] — a root of the shots area,
 * so a teammate's shot edit or a finished shot_tips job refreshes it — and the
 * per-scene job (follow it with trackJob(tipsSlot(sceneId), job_id)).
 */

export const tipsKeys = {
  view: ['tips'] as const,
};

export function useShotTips() {
  return useQuery({ queryKey: tipsKeys.view, queryFn: ({ signal }) => api.call('getShotTips', undefined, { signal }) });
}

export function useStartShotTips() {
  return useMutation({ mutationFn: (sceneId: string) => api.call('startShotTips', undefined, { params: { id: sceneId } }) });
}
