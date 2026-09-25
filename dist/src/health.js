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
const HEALTH_CATEGORIES = new Set([
    "unsupported-model",
    "auth",
    "quota",
    "timeout",
    "network",
    "provider-stream",
    "launch",
    "cancellation",
    "task-failure",
    "cleanup",
    "unknown",
]);
export function isHealthCategory(value) {
    return typeof value === "string" && HEALTH_CATEGORIES.has(value);
}
/**
 * Categories that count against model health: these are provider/serving
 * failures. `launch` never reaches the applied model (the child did not start),
 * `cancellation` and `task-failure` describe user intent or the assignment, and
 * `cleanup` is an admission issue owned by the slot pool. `unknown` is
 * deliberately not counted: opening a circuit on an unclassified child outcome
 * would punish a model for a task it may simply have failed.
 */
const HEALTH_FAILURE_CATEGORIES = new Set([
    "unsupported-model",
    "auth",
    "quota",
    "timeout",
    "network",
    "provider-stream",
]);
export function isHealthFailure(category) {
    return HEALTH_FAILURE_CATEGORIES.has(category);
}
export const DEFAULT_HEALTH = {
    enabled: true,
    failureThreshold: 3,
    windowMinutes: 5,
    cooldownMinutes: 60,
};
/** Repeated half-open failures back off, but never without bound. */
export const MAX_COOLDOWN_MULTIPLIER = 16;
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
export const TRIAL_MAX_AGE_MS = 30 * 60_000;
export function resolveHealthConfig(config) {
    return {
        enabled: config?.enabled ?? DEFAULT_HEALTH.enabled,
        failureThreshold: config?.failureThreshold ?? DEFAULT_HEALTH.failureThreshold,
        windowMinutes: config?.windowMinutes ?? DEFAULT_HEALTH.windowMinutes,
        cooldownMinutes: config?.cooldownMinutes ?? DEFAULT_HEALTH.cooldownMinutes,
        ...(config?.path ? { path: config.path } : {}),
    };
}
export function emptyHealthState() {
    return { version: 1, models: {} };
}
function pruneFailures(failures, now, windowMinutes) {
    if (!Array.isArray(failures))
        return [];
    const cutoff = now - windowMinutes * 60_000;
    return failures.filter((ts) => typeof ts === "number" && Number.isFinite(ts) && ts >= cutoff);
}
/**
 * Whether a persisted trial claim still counts. A claim is live only while its
 * own timestamp is valid, not future-dated, and younger than `TRIAL_MAX_AGE_MS`.
 * A claim with no timestamp (a state file written before claims were stamped)
 * cannot be shown to be live, so it is treated as expired rather than trusted —
 * the alternative is a model excluded forever on the strength of a missing field.
 */
export function isTrialClaimLive(record, now) {
    if (record?.trialActive !== true)
        return false;
    const claimedAt = record.trialClaimedAt;
    if (typeof claimedAt !== "number" || !Number.isFinite(claimedAt))
        return false;
    if (claimedAt > now)
        return false;
    return now - claimedAt < TRIAL_MAX_AGE_MS;
}
export function getCircuitState(state, key, now, config) {
    const resolved = resolveHealthConfig(config);
    const record = state.models[key];
    const failures = pruneFailures(record?.failures, now, resolved.windowMinutes);
    const openUntil = record?.openUntil;
    const open = typeof openUntil === "number" && openUntil > now;
    const trialActive = open ? false : isTrialClaimLive(record, now);
    return {
        open,
        halfOpen: typeof openUntil === "number" && openUntil <= now && !trialActive,
        trialActive,
        ...(typeof openUntil === "number" ? { openUntil } : {}),
        ...(trialActive ? { trialClaimedAt: record.trialClaimedAt } : {}),
        recentFailures: failures.length,
    };
}
/**
 * Record one health failure. Non-health categories are ignored so the caller can
 * feed every outcome without a second classification step. A half-open trial
 * failure ALWAYS reopens the circuit (with bounded backoff), independent of the
 * threshold — that is what makes recovery single-trial rather than thrashing.
 */
export function recordHealthFailure(state, key, config, now, category) {
    const resolved = resolveHealthConfig(config);
    if (!resolved.enabled)
        return state;
    if (!isHealthFailure(category))
        return state;
    const current = state.models[key] ?? { failures: [] };
    const wasTrial = isTrialClaimLive(current, now);
    const baseMultiplier = current.cooldownMultiplier && current.cooldownMultiplier > 0 ? current.cooldownMultiplier : 1;
    const cooldownMultiplier = wasTrial ? Math.min(baseMultiplier * 2, MAX_COOLDOWN_MULTIPLIER) : baseMultiplier;
    const failures = [...pruneFailures(current.failures, now, resolved.windowMinutes), now];
    const shouldOpen = wasTrial || failures.length >= resolved.failureThreshold;
    const openUntil = shouldOpen
        ? now + resolved.cooldownMinutes * 60_000 * cooldownMultiplier
        : current.openUntil;
    return {
        ...state,
        models: {
            ...state.models,
            [key]: {
                failures,
                ...(typeof openUntil === "number" ? { openUntil } : {}),
                // The claim is consumed either way; a failure must not leave one behind.
                cooldownMultiplier: cooldownMultiplier,
                lastFailureAt: now,
                lastFailureCategory: category,
            },
        },
    };
}
/** A successful infrastructure execution clears the circuit and any backoff. */
export function recordHealthSuccess(state, key, now) {
    const current = state.models[key];
    return {
        ...state,
        models: {
            ...state.models,
            [key]: {
                failures: [],
                ...(current?.lastFailureAt !== undefined ? { lastFailureAt: current.lastFailureAt } : {}),
                ...(current?.lastFailureCategory ? { lastFailureCategory: current.lastFailureCategory } : {}),
                lastSuccessAt: now,
            },
        },
    };
}
/**
 * Claim the single half-open trial, stamped with the claim time so a crashed or
 * killed process cannot leave the model claimed forever. No-op when the circuit
 * is still open or a live claim already exists.
 */
export function beginTrial(state, key, now) {
    const current = state.models[key];
    if (!current)
        return state;
    if (getCircuitState(state, key, now).trialActive)
        return state;
    return { ...state, models: { ...state.models, [key]: { ...current, trialActive: true, trialClaimedAt: now } } };
}
/** Release an owned trial without treating a cancellation as success or failure. */
export function abandonTrial(state, key) {
    const current = state.models[key];
    if (!current?.trialActive)
        return state;
    const { trialActive: _trialActive, trialClaimedAt: _trialClaimedAt, ...rest } = current;
    return { ...state, models: { ...state.models, [key]: rest } };
}
// ── Child outcome classification ─────────────────────────────
const CHILD_ERROR_PATTERNS = [
    // Explicit task/limit outcomes must be read before the generic provider
    // patterns: a length-capped answer is the assignment hitting a budget, not a
    // broken provider.
    [/stopreason (length|max_tokens)|output length|max ?tokens/i, "task-failure"],
    [/not supported when using codex|model is not supported|free tier|can only be used from within|unknown model|model not found|no such model|does not support/i, "unsupported-model"],
    [/\b401\b|unauthorized|authentication|auth failed|invalid api key|api key|credential|permission denied|access denied/i, "auth"],
    [/\b429\b|rate.?limit|quota|usage limit|too many requests|insufficient (quota|credits?|balance)|billing|exhaust/i, "quota"],
    [/timed?\s*out|timeout|deadline exceeded/i, "timeout"],
    [/enotfound|econnrefused|econnreset|network|fetch failed|socket|connection (refused|reset|error)|dns|offline/i, "network"],
    [/cleanup|process group|descendant|process still|kill failed/i, "cleanup"],
    [/cancel|aborted by (user|request)|user cancel/i, "cancellation"],
    [/stream|sse|provider request failed|provider reported an error|no assistant completion|stopped early|deferred|pending|aborted/i, "provider-stream"],
];
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
export function classifyChildError(message) {
    const text = (message ?? "").toLowerCase().trim();
    if (text === "")
        return "unknown";
    for (const [pattern, category] of CHILD_ERROR_PATTERNS) {
        if (pattern.test(text))
            return category;
    }
    return "unknown";
}
/**
 * Decide what a finished child means for model health. `processStarted` is the
 * gate: before a child actually starts there is no applied model to blame.
 *
 * `failed` with no reported error is `unknown` via `classifyChildError`, so a
 * non-zero exit AFTER a completed answer does not open the circuit; the child
 * result still reports the failure to the parent.
 */
export function classifyChildHealth(input) {
    if (input.processStarted === false)
        return { kind: "none", category: "launch" };
    if (input.status === "success") {
        if (input.observedExit === false || input.groupCleaned === false) {
            return { kind: "none", category: "cleanup" };
        }
        return { kind: "success" };
    }
    if (input.status === "cancelled")
        return { kind: "none", category: "cancellation" };
    if (input.status === "limit-exceeded")
        return { kind: "none", category: "task-failure" };
    // `timed-out` is the child wall-clock envelope, not proof that the provider
    // timed out. Treat it like an assignment limit; provider timeout evidence is
    // classified from a failed result's structured error instead.
    if (input.status === "timed-out")
        return { kind: "none", category: "task-failure" };
    if (input.status === "launch-error")
        return { kind: "none", category: "launch" };
    const category = classifyChildError(input.error ?? "");
    return isHealthFailure(category)
        ? { kind: "failure", category }
        : { kind: "none", category };
}
