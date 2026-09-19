const COMPLETE_STOP_REASONS = new Set(["stop", "toolUse"]);
const INCOMPLETE_STOP_REASONS = new Set(["error", "aborted", "length", "deferred", "pending"]);
function identityFromEvidence(value) {
    if (!value)
        return undefined;
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1)
        return undefined;
    return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
/**
 * Append with explicit truncation accounting. Retains the TAIL (most recent)
 * when the limit is hit and flags the result so the caller reports truncation
 * instead of presenting partial text as complete output (F11).
 */
function appendBounded(current, next, limit) {
    if (limit <= 0)
        return { text: "", truncated: current.length > 0 || next.length > 0 };
    const combined = current + next;
    if (combined.length <= limit)
        return { text: combined, truncated: false };
    return { text: combined.slice(combined.length - limit), truncated: true };
}
/** Merge a per-turn usage event into running totals without dropping earlier fields. */
function mergeUsage(total, event) {
    if (!event)
        return total;
    const merged = { ...(total ?? {}) };
    const add = (key, value) => {
        if (value === undefined)
            return;
        const prior = merged[key] ?? 0;
        merged[key] = prior + value;
    };
    add("inputTokens", event.inputTokens);
    add("outputTokens", event.outputTokens);
    add("totalTokens", event.totalTokens);
    add("cacheReadTokens", event.cacheReadTokens);
    add("cacheWriteTokens", event.cacheWriteTokens);
    add("cost", event.cost);
    return merged;
}
export class ChildRunner {
    spawner;
    constructor(spawner) {
        this.spawner = spawner;
    }
    async run(request, onProgress) {
        if (request.signal?.aborted) {
            return {
                status: "cancelled",
                output: "",
                appliedModel: request.model,
                requestedModel: request.model,
                diagnostics: [],
                observedExit: false,
                groupCleaned: true,
            };
        }
        const outputLimit = request.maxOutputChars ?? 50_000;
        const diagnostics = [];
        let output = "";
        let outputTruncated = false;
        let appliedModel = request.model;
        let servedModel;
        let sawAssistantCompletion = false;
        let sawAnyAssistant = false;
        let turns = 0;
        let providerError;
        let incompleteStopReason;
        let usage;
        let sawTimeout = false;
        let limitExceeded = false;
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        const timeout = request.wallTimeMs
            ? setTimeout(() => {
                sawTimeout = true;
                controller.abort();
            }, request.wallTimeMs)
            : undefined;
        try {
            const spawnRequest = { ...request, signal: controller.signal };
            const process = await this.spawner.spawn(spawnRequest, (event) => {
                if (event.type === "assistant") {
                    turns += 1;
                    // Turn budget: reject the turn that would exceed the limit BEFORE
                    // consuming it, so no inference beyond the budget is counted (F11).
                    if (request.maxTurns !== undefined && turns > request.maxTurns) {
                        limitExceeded = true;
                        controller.abort();
                    }
                    if (event.usage)
                        usage = mergeUsage(usage, event.usage);
                    const evidence = identityFromEvidence(event.model);
                    if (evidence)
                        appliedModel = evidence;
                    const served = identityFromEvidence(event.responseModel);
                    if (served)
                        servedModel = served;
                    sawAnyAssistant = true;
                    const stop = event.stopReason;
                    if (stop === undefined || COMPLETE_STOP_REASONS.has(stop)) {
                        // A missing stopReason on a completed assistant message is not
                        // treated as failure on its own; only non-success reasons are.
                        sawAssistantCompletion = true;
                    }
                    else if (INCOMPLETE_STOP_REASONS.has(stop)) {
                        incompleteStopReason = stop;
                    }
                    else {
                        incompleteStopReason = stop;
                    }
                    if (event.errorMessage || stop === "error")
                        providerError = event.errorMessage ?? "Child provider reported an error";
                    const appended = appendBounded(output, event.text, outputLimit);
                    output = appended.text;
                    outputTruncated = outputTruncated || appended.truncated;
                }
                else if (event.type === "progress") {
                    onProgress?.(event.text);
                }
                else {
                    if (diagnostics.length < 200)
                        diagnostics.push(event.text.slice(-2_000));
                }
            });
            const cancelled = request.signal?.aborted === true;
            // Truthful status ladder (F07):
            // 1. explicit cancellation
            // 2. turn-limit exceeded
            // 3. wall-clock timeout
            // 4. provider-reported error
            // 5. incomplete stopReason (aborted/length/deferred/pending)
            // 6. zero-exit process that never produced an assistant completion
            // 7. nonzero/unobserved exit
            // only otherwise success.
            const status = cancelled
                ? "cancelled"
                : limitExceeded
                    ? "limit-exceeded"
                    : sawTimeout
                        ? "timed-out"
                        : providerError
                            ? "failed"
                            : incompleteStopReason
                                ? "failed"
                                : !sawAssistantCompletion
                                    ? "failed"
                                    : process.exitCode !== 0 || !process.observedExit
                                        ? process.observedExit
                                            ? "failed"
                                            : "launch-error"
                                        : "success";
            return {
                status,
                output,
                appliedModel,
                ...(servedModel ? { servedModel } : {}),
                requestedModel: request.model,
                exitCode: process.exitCode,
                ...(usage ? { usage } : {}),
                ...(providerError
                    ? { error: providerError }
                    : incompleteStopReason
                        ? { error: `Child stopped early: stopReason ${incompleteStopReason}` }
                        : !sawAssistantCompletion && sawAnyAssistant === false
                            ? { error: "Child produced no assistant completion" }
                            : {}),
                diagnostics,
                observedExit: process.observedExit,
                ...(process.processStarted !== undefined ? { processStarted: process.processStarted } : {}),
                ...(process.groupCleaned !== undefined ? { groupCleaned: process.groupCleaned } : {}),
                ...(outputTruncated ? { outputTruncated: true } : {}),
            };
        }
        catch (error) {
            const cancelled = request.signal?.aborted === true;
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                status: cancelled ? "cancelled" : limitExceeded ? "limit-exceeded" : sawTimeout ? "timed-out" : "launch-error",
                output,
                appliedModel,
                ...(servedModel ? { servedModel } : {}),
                requestedModel: request.model,
                error: errorMessage,
                diagnostics,
                observedExit: false,
                ...(outputTruncated ? { outputTruncated: true } : {}),
            };
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            request.signal?.removeEventListener("abort", onAbort);
        }
    }
}
export { identityFromEvidence as modelFromEvidence, mergeUsage };
