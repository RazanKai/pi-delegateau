import { type CostModeConfig } from "./quota.js";
import { type ProbeCache, type ProbeResult } from "./reachability.js";
import type { BenchmarkEvidence, CandidateProfile } from "./types.js";
export type { BenchmarkEvidence } from "./types.js";
export interface RegistryForSetup {
    getAvailable(): readonly RegistrySetupModel[];
    hasConfiguredAuth(model: RegistrySetupModel): boolean;
}
export interface RegistrySetupModel {
    provider: string;
    id: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: string[];
    cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
    };
    latencyMs?: number;
}
export interface SetupCandidate extends CandidateProfile {
    probe?: ProbeResult;
    accessMode: "token" | "quota-gpu-time";
    accessDecision: string;
    state: "unmeasured" | "reachable" | "unreachable";
}
export interface SetupPlan {
    candidates: SetupCandidate[];
    agents: Record<string, unknown>;
    reasons: string[];
}
export declare function detectWebAccessExtensions(tools: readonly unknown[]): string[];
/** Discover only models Pi currently exposes AND says have configured auth. */
export declare function discoverSetupCandidates(registry: RegistryForSetup, costMode?: CostModeConfig): SetupCandidate[];
/** Only identical source/benchmark/version/metric/unit/direction records are comparable. */
export declare function pruneSetupCandidates(candidates: SetupCandidate[], evidence?: BenchmarkEvidence[], probes?: ProbeCache): {
    candidates: SetupCandidate[];
    reasons: string[];
};
export declare function roleTemplates(installedExtensions?: readonly string[]): {
    agents: Record<string, unknown>;
    unavailable: string[];
};
export declare function buildSetupPlan(registry: RegistryForSetup, options?: {
    costMode?: CostModeConfig;
    probes?: ProbeCache;
    evidence?: BenchmarkEvidence[];
    installedExtensions?: string[];
}): SetupPlan;
/** Explicit opt-in only. Callers must set optIn; no import/session path calls this. */
export declare function measureQuotaCost<T>(optIn: boolean, measure: () => Promise<T>): Promise<T | undefined>;
export declare function probeSetupPlan(plan: SetupPlan, options: {
    cwd: string;
    command?: string;
}): Promise<ProbeCache>;
/** Safe config projection: no credential/auth/cache/telemetry fields are representable. */
export declare function setupConfig(plan: SetupPlan): Record<string, unknown>;
/** Writes only after caller's explicit affirmative confirmation. Existing files require overwrite too. */
export declare function writeSetupConfig(cwd: string, config: Record<string, unknown>, confirmed: boolean, overwrite?: boolean): string | undefined;
