/**
 * Timing budgets in tests are targets measured on an idle development
 * machine (SPEC §11.1: 待实测，不是已达性能). By default they get 3× headroom
 * so a busy laptop or CI runner does not fail the suite; set
 * STORYSCRIPT_PERF_STRICT=1 to enforce the raw numbers.
 */
export const PERF_SLACK = process.env.STORYSCRIPT_PERF_STRICT === '1' ? 1 : 3;

export const budget = (ms: number): number => ms * PERF_SLACK;
