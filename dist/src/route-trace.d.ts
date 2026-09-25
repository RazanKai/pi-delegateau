import type { HealthCategory } from "./health.js";
import type { BenchmarkEvidence, SelectionSource } from "./types.js";
/**
 * Structured route trace.
 *
 * PURPOSE: make every delegation/selection decision explainable after the fact
 * without persisting private data. The trace is linked to the existing receipt
 * by `dispatchId`/`decisionId` and is written through the same `receipts.ts`
 * path — it is an extension of the receipt record, not a second logging system.
 *
 * SAFETY: the builder only accepts structured identities, stable reasons and
 * numbers. It has no parameter for task text, prompt text, context, child
 * output, repository contents, secrets or raw provider bodies, so those cannot
 * leak into the trace even by mistake. Lists are capped so the record is bounded.
 */
export type RouteExclusionReason = "not-in-registry" | "no-auth" | "unreachable" | "quota-exhausted" | "circuit-open" | "trial-active" | "child-tools-invalid";
export interface RouteExcludedCandidate {
    id: string;
    reasons: RouteExclusionReason[];
    openUntil?: string;
}
export interface RouteTraceFilters {
    /** Candidate ids excluded because a provider quota window was at the floor. */
    quotaExcluded: string[];
    /** Candidate ids excluded by a fresh negative reachability probe. */
    unreachable: string[];
    /** Candidate ids excluded because their health circuit is open. */
    circuitOpen: string[];
    /** Candidate ids excluded because a half-open trial is already in flight. */
    trialActive: string[];
}
export interface RouteTraceJev {
    latencyMs?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
}
export interface RouteTraceBenchmarks {
    /** True only when these records were included in the model Choice request. */
    offeredToJev: boolean;
    records: BenchmarkEvidence[];
    /** Records the chooser actually received, before the trace's own cap. */
    offeredCount: number;
    /** True when the trace cap dropped records; `records` is then a prefix. */
    truncated: boolean;
}
export interface RouteTrace {
    version: 1;
    dispatchId: string;
    decisionId?: string;
    agent: string;
    startedAt: string;
    endedAt: string;
    candidateIds: string[];
    excluded: RouteExcludedCandidate[];
    selectionSource: SelectionSource | "unselected";
    requestedModel?: string;
    selectedModel?: string;
    appliedModel?: string;
    servedModel?: string;
    jev?: RouteTraceJev;
    benchmarks?: RouteTraceBenchmarks;
    filters: RouteTraceFilters;
    outcome: string;
    errorCategory?: HealthCategory;
}
export interface RouteTraceInput {
    dispatchId: string;
    decisionId?: string;
    agent: string;
    startedAt: string;
    endedAt: string;
    candidateIds: string[];
    excluded: RouteExcludedCandidate[];
    selectionSource: SelectionSource | "unselected";
    requestedModel?: string;
    selectedModel?: string;
    appliedModel?: string;
    servedModel?: string;
    jev?: RouteTraceJev;
    benchmarkEvidence?: BenchmarkEvidence[];
    benchmarksOfferedToJev?: boolean;
    outcome: string;
    errorCategory?: HealthCategory;
}
export declare const MAX_TRACE_LIST = 200;
/**
 * Upper bound on benchmark records stored in one trace. The chooser has no such
 * cap (it receives every eligible candidate's records), so a trace that clipped
 * silently would let a reader reconstruct a decision from an incomplete list and
 * never know. `truncated`/`offeredCount` make the difference explicit.
 */
export declare const MAX_TRACE_BENCHMARKS = 512;
/** Collapse repeated exclusions for the same candidate, preserving order. */
export declare function mergeExcludedCandidates(...lists: RouteExcludedCandidate[][]): RouteExcludedCandidate[];
export declare function buildRouteTrace(input: RouteTraceInput): RouteTrace;
