import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SaveUsagePriceInput, ScriptCheckView, ScriptRisk } from '@storyscript/contracts';
import { api } from './api.ts';

/**
 * S5: the script check (under ['script', …], so a new script version, a
 * finished check and a teammate's tick all refresh it) and the usage report
 * (under ['jobs', …]: every finished job moves it; the settings area also
 * lists it, for a price the leader changes).
 */

export const checkKeys = {
  view: ['script', 'check'] as const,
  usage: ['jobs', 'usage'] as const,
};

export function useScriptCheck() {
  return useQuery({ queryKey: checkKeys.view, queryFn: ({ signal }) => api.call('getScriptCheck', undefined, { signal }), staleTime: 0 });
}

export function useStartScriptCheck() {
  return useMutation({ mutationFn: () => api.call('startScriptCheck', undefined) });
}

/** Tick on / off; the list shows it at once and settles on the server's answer. */
export function useSetRiskHandled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, handled }: { id: string; handled: boolean }) => api.call('setRiskHandled', { handled }, { params: { id } }),
    onSuccess: (risk: ScriptRisk) => {
      qc.setQueryData<ScriptCheckView>(checkKeys.view, (old) => (old ? { ...old, risks: old.risks.map((r) => (r.id === risk.id ? risk : r)) } : old));
    },
    onError: () => void qc.invalidateQueries({ queryKey: checkKeys.view }),
  });
}

export function useUsage() {
  return useQuery({ queryKey: checkKeys.usage, queryFn: ({ signal }) => api.call('getUsage', undefined, { signal }), staleTime: 0 });
}

export function useSaveUsagePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveUsagePriceInput) => api.call('saveUsagePrice', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: checkKeys.usage }),
  });
}
