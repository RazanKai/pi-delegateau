import { modelKey } from "./types.js";
// Error classification persisted instead of raw remote text. Gate/chooser
// failures are categorized; the raw service message never reaches receipts
// because it can echo private prompt content (F08).
const ERROR_CATEGORIES = [
    [/no api key|api key|credentials|credential|auth/i, "credential-missing"],
    [/deadline|timeout|timed?\s*out/i, "timeout"],
    [/invalid|malformed|no valid|unexpected|must be/i, "invalid-response"],
    [/cancel/i, "cancelled"],
    [/prohibited/i, "sensing-prohibited"],
];
export function classifyError(message) {
    if (!message)
        return undefined;
    for (const [pattern, category] of ERROR_CATEGORIES) {
        if (pattern.test(message))
            return category;
    }
    return "sensor-error";
}
export function buildDecisionReceipt(decision, outcome) {
    return JSON.parse(JSON.stringify({
        decisionId: decision.decisionId,
        generation: decision.generation,
        policy: decision.policy,
        baseMode: decision.baseMode,
        source: decision.source,
        status: decision.status,
        restriction: decision.restriction,
        ...(decision.recommendation ? { recommendation: decision.recommendation } : {}),
        childAvailable: decision.childAvailable,
        eligibleChildIds: decision.eligibleChildIds,
        childAgentNames: decision.childAgentNames,
        execution: decision.execution,
        outcome,
        ...(decision.reason ? { reason: classifyError(decision.reason) ?? sanitizeError(decision.reason) } : {}),
        ...(decision.invalidationReason ? { invalidationReason: sanitizeError(decision.invalidationReason) } : {}),
        ...(decision.override ? { override: decision.override } : {}),
        ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        ...(decision.latencyMs !== undefined ? { latencyMs: decision.latencyMs } : {}),
        ...(decision.usage ? { usage: decision.usage } : {}),
    }));
}
/**
 * Sanitize an error message for display. NOTE: this is for transient UI text
 * only; persistent receipts must use classifyError() so remote bodies that
 * may echo private prompts never reach disk (F08).
 */
export function sanitizeError(message, secrets = []) {
    let result = message.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");
    for (const secret of secrets)
        if (secret)
            result = result.split(secret).join("[redacted]");
    return result.slice(0, 2_000);
}
export function buildReceipt(input) {
    const { task: _task, expectedOutput: _expectedOutput, context: _context, ...safe } = input;
    return JSON.parse(JSON.stringify(safe));
}
/** Build a short human-readable dispatch summary including served-model evidence. */
export function dispatchSummary(result, selectionSource, requested) {
    const applied = modelKey(result.appliedModel);
    const requestedKey = modelKey(requested);
    const served = result.servedModel ? modelKey(result.servedModel) : undefined;
    const substitution = served && served !== applied ? `\nProvider served model evidence: ${served}` : "";
    return applied === requestedKey
        ? `${selectionSource} (${applied})${substitution}`
        : `${selectionSource} (requested ${requestedKey}, applied ${applied})${substitution}`;
}
