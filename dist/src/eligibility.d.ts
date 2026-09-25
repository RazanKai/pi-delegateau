import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HealthGate } from "./health.js";
import { type QuotaState } from "./quota.js";
import { type ProbeCache } from "./reachability.js";
import type { RouteExcludedCandidate } from "./route-trace.js";
import { type CandidateProfile, type DelegateConfig, type ModelIdentity, type TrustedAgent } from "./types.js";
/**
 * One shared candidate-eligibility resolver for BOTH the delegation gate and the
 * dispatch path, so "a child is available" means exactly what dispatch can
 * launch. It folds together the hard filters that already existed (registry
 * presence, configured auth, quota floor, reachability, child-tool validity)
 * with the new runtime health circuit, and returns the excluded candidates with
 * stable reasons for the route trace.
 *
 * Health is applied HERE, before Jev: an open circuit's model never reaches the
 * chooser, which is the whole point of persisting the failure.
 */
export declare const DELEGATE_TOOL_NAME = "delegate_task";
export interface EligibleResolution {
    candidates: CandidateProfile[];
    excluded: RouteExcludedCandidate[];
}
export interface ResolveEligibleOptions {
    config: DelegateConfig;
    agent: TrustedAgent;
    ctx: ExtensionContext;
    quotaState?: QuotaState;
    health?: HealthGate;
    /** Overlay provider-registered metadata; the gate can skip this enrichment. */
    enrich?: boolean;
    now?: number;
    /** Injectable reachability source for deterministic tests. */
    probeCache?: ProbeCache | undefined;
    isUnreachable?: (identity: ModelIdentity) => boolean;
}
/** Whether an agent's configured child tools are structurally launchable at all. */
export declare function childToolsInvalid(agent: TrustedAgent): boolean;
export declare function resolveEligibleCandidates(options: ResolveEligibleOptions): EligibleResolution;
