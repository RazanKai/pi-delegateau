import { readQuotaState, readQuotaStore } from "./quota.js";
/**
 * Build the JevSelector options with the measured quota store attached.
 *
 * Kept in one place because three call sites need identical behaviour, and the
 * store must be read fresh (a measurement written by an earlier session is
 * exactly the case this supports — the pool is resolved per dispatch, so last
 * session's measurement is valid). Reading is synchronous and cheap; a missing
 * or corrupt store degrades to "no quota data" rather than failing selection.
 */
export function quotaSelectorOptions(timeoutMs, costModeConfig, currentQuotaState) {
    let store;
    let quotaState;
    try {
        store = readQuotaStore();
        const state = currentQuotaState ?? readQuotaState();
        quotaState = Object.keys(state).length > 0 ? state : undefined;
    }
    catch {
        store = undefined;
        quotaState = undefined;
    }
    return {
        timeoutMs,
        ...(store ? { quotaStore: store } : {}),
        ...(quotaState ? { quotaState } : {}),
        ...(costModeConfig ? { costModeConfig } : {}),
    };
}
