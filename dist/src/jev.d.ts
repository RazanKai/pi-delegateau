import type { JevChoiceAnswer, JevChoiceInput } from "./types.js";
import { type JevClientLike } from "./jev-client.js";
import type { ChoiceRuntime } from "./selection.js";
import { type CostModeConfig, type QuotaState, type QuotaStore } from "./quota.js";
export type { JevClientLike } from "./jev-client.js";
export declare class JevSelector implements ChoiceRuntime {
    private readonly client;
    private readonly timeoutMs;
    /** Measured quota coefficients for quota-metered providers, if any exist. */
    private readonly quotaStore;
    /** Per-provider live budget state, if a provider snapshot exists. */
    private readonly quotaState;
    /** Per-provider metering overrides from config. */
    private readonly costModeConfig;
    /**
     * Client construction is defensive (F01 class): a missing API key or
     * transport failure becomes a normal choose() error inside the selection
     * deadline/fallback logic instead of a constructor throw outside it.
     */
    constructor(options?: {
        client?: JevClientLike;
        timeoutMs?: number;
        quotaStore?: QuotaStore;
        quotaState?: QuotaState;
        costModeConfig?: CostModeConfig;
    });
    choose(input: JevChoiceInput): Promise<JevChoiceAnswer>;
}
