import { readQuotaStore, type CostModeConfig, type QuotaStore } from "./quota.js";

/**
 * Build the JevSelector options with the measured quota store attached.
 *
 * Kept in one place because three call sites need identical behaviour, and the
 * store must be read fresh (a measurement written by an earlier session is
 * exactly the case this supports — the pool is resolved per dispatch, so last
 * session's measurement is valid). Reading is synchronous and cheap; a missing
 * or corrupt store degrades to "no quota data" rather than failing selection.
 */
export function quotaSelectorOptions(
  timeoutMs: number,
  costModeConfig?: CostModeConfig,
): { timeoutMs: number; quotaStore?: QuotaStore; costModeConfig?: CostModeConfig } {
  let store: QuotaStore | undefined;
  try {
    store = readQuotaStore();
  } catch {
    store = undefined;
  }
  return {
    timeoutMs,
    ...(store ? { quotaStore: store } : {}),
    ...(costModeConfig ? { costModeConfig } : {}),
  };
}
