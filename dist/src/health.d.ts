/**
 * Runtime health: a small circuit breaker for child model serving.
 *
 * WHY THIS EXISTS: a delegated child can fail for reasons that have nothing to
 * do with the assignment — a provider refuses the model, the credential is
 * rejected, the quota is spent, the stream breaks. Those are repeated on the
 * next dispatch unless the failure is remembered. This module keeps a bounded,
 * persisted circuit per exact provider/model identity so an unhealthy candidate
 * is excluded BEFORE the chooser is asked, and recovers through exactly one
 * half-open trial after a cooldown.
 *
 * DESIGN CONSTRAINTS (adapted from pi-bifrost's reliability core, which is
 * design research rather than a dependency):
 *   - pure transitions, no I/O here; `health-store.ts` owns persistence;
 *   - stable categories only — raw provider bodies are never persisted;
 *   - user cancellation, ordinary child task failure and cleanup failure are
 *     NOT model-health failures;
 *   - health is applied to the model the provider actually served, so a
 *     substitution does not blame the requested identity.
 */
/** Stable failure taxonomy persisted in health state and route traces. */
export type HealthCategory = "unsupported-model" | "auth" | "quota" | "timeout" | "network" | "provider-stream" | "launch" | "cancellation" | "task-failure" | "cleanup" | "unknown";
export declare function isHealthCategory(value: unknown): value is HealthCategory;
export declare function isHealthFailure(category: HealthCategory): boolean;
export interface HealthConfig {
    enabled?: boolean;
    failureThreshold?: number;
    windowMinutes?: number;
    cooldownMinutes?: number;
    /** Custom state path; relative paths resolve against cwd, `~` is expanded. */
    path?: string;
}
export declare const DEFAULT_HEALTH: {
    readonly enabled: true;
    readonly failureThreshold: 3;
    readonly windowMinutes: 5;
    readonly cooldownMinutes: 60;
};
/** Repeated half-open failures back off, but never without bound. */
export declare const MAX_COOLDOWN_MULTIPLIER = 16;
/**
 * How long a claimed half-open trial stays claimed. A claim exists so two
 * concurrent dispatches cannot both trial the same model, which requires the
 * claim to outlive one process — but an unbounded claim outlives the PROCESS
 * THAT CRASHED and then excludes the model with no way back (it is neither open
 * nor healthy, so `/delegateau status` reports nothing wrong and every dispatch
 * fails `trial-in-progress`). Expiry is therefore the recovery path: after this
 * long the model returns to the half-open state and the next dispatch may claim
 * the trial again. Trade-off: a child that legitimately runs longer than this
 * can be trialled by a second concurrent dispatch.
 */
export declare const TRIAL_MAX_AGE_MS: number;
export interface ResolvedHealthConfig {
    enabled: boolean;
    failureThreshold: number;
    windowMinutes: number;
    cooldownMinutes: number;
    path?: string;
}
export declare function resolveHealthConfig(config?: HealthConfig): ResolvedHealthConfig;
export interface HealthRecord {
    failures: number[];
    openUntil?: number;
    trialActive?: boolean;
    /** When the trial was claimed; a claim without one is treated as expired. */
    trialClaimedAt?: number;
    cooldownMultiplier?: number;
    lastFailureAt?: number;
    lastFailureCategory?: HealthCategory;
    lastSuccessAt?: number;
}
export interface HealthState {
    version: 1;
    models: Record<string, HealthRecord>;
}
export interface CircuitState {
    open: boolean;
    halfOpen: boolean;
    trialActive: boolean;
    openUntil?: number;
    /** When the live trial was claimed; only present while `trialActive`. */
    trialClaimedAt?: number;
    recentFailures: number;
}
/** Read-only seam consumed by candidate eligibility; `HealthStore` implements it. */
export interface HealthGate {
    circuit(key: string, now?: number): CircuitState;
}
export declare function emptyHealthState(): HealthState;
/**
 * Whether a persisted trial claim still counts. A claim is live only while its
 * own timestamp is valid, not future-dated, and younger than `TRIAL_MAX_AGE_MS`.
 * A claim with no timestamp (a state file written before claims were stamped)
 * cannot be shown to be live, so it is treated as expired rather than trusted —
 * the alternative is a model excluded forever on the strength of a missing field.
 */
export declare function isTrialClaimLive(record: HealthRecord | undefined, now: number): boolean;
export declare function getCircuitState(state: HealthState, key: string, now: number, config?: HealthConfig): CircuitState;
/**
 * Record one health failure. Non-health categories are ignored so the caller can
 * feed every outcome without a second classification step. A half-open trial
 * failure ALWAYS reopens the circuit (with bounded backoff), independent of the
 * threshold — that is what makes recovery single-trial rather than thrashing.
 */
export declare function recordHealthFailure(state: HealthState, key: string, config: HealthConfig | undefined, now: number, category: HealthCategory): HealthState;
/** A successful infrastructure execution clears the circuit and any backoff. */
export declare function recordHealthSuccess(state: HealthState, key: string, now: number): HealthState;
/**
 * Claim the single half-open trial, stamped with the claim time so a crashed or
 * killed process cannot leave the model claimed forever. No-op when the circuit
 * is still open or a live claim already exists.
 */
export declare function beginTrial(state: HealthState, key: string, now: number): HealthState;
/** Release an owned trial without treating a cancellation as success or failure. */
export declare function abandonTrial(state: HealthState, key: string): HealthState;
/**
 * Map a raw child error body to a stable category. Raw text is never persisted;
 * an unrecognised body becomes `unknown`, which does not count against health.
 *
 * An EMPTY body is also `unknown`. It used to be `provider-stream`, which meant
 * a child that answered normally and then exited non-zero (a truncated pipe, a
 * post-answer crash) opened the model's circuit — the child produced its work
 * and the model was punished for how the process ended. Provider-stream evidence
 * is a *reported* provider error, so it needs an actual error string.
 */
export declare function classifyChildError(message: string): HealthCategory;
export interface ChildHealthInput {
    status: string;
    error?: string;
    processStarted?: boolean;
    observedExit?: boolean;
    groupCleaned?: boolean;
}
export type ChildHealthVerdict = {
    kind: "success";
} | {
    kind: "failure";
    category: HealthCategory;
} | {
    kind: "none";
    category: HealthCategory;
};
/**
 * Decide what a finished child means for model health. `processStarted` is the
 * gate: before a child actually starts there is no applied model to blame.
 *
 * `failed` with no reported error is `unknown` via `classifyChildError`, so a
 * non-zero exit AFTER a completed answer does not open the circuit; the child
 * result still reports the failure to the parent.
 */
export declare function classifyChildHealth(input: ChildHealthInput): ChildHealthVerdict;
