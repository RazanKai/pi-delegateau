import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { modelKey } from "./types.js";
export class JevSelector {
    client;
    timeoutMs;
    /**
     * Client construction is defensive (F01 class): a missing API key or
     * transport failure becomes a normal choose() error inside the selection
     * deadline/fallback logic instead of a constructor throw outside it.
     */
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs ?? 2_000;
        if (options.client) {
            this.client = options.client;
            return;
        }
        try {
            this.client = new TypeSafeClient({ timeout: this.timeoutMs, retry: { maxRetries: 0 } });
        }
        catch {
            this.client = undefined;
        }
    }
    async choose(input) {
        if (!this.client)
            throw new Error("Model chooser sensor is unavailable: no credentials or transport configured");
        const criteria = {};
        for (const candidate of input.state.candidates) {
            criteria[`${candidate.identity.provider}/${candidate.identity.id}`] = candidate.description;
        }
        // Known candidate metadata is forwarded to the chooser (F10): provenance,
        // cost, latency and context window are what let the chooser interpret the
        // user's routing preference. Unknown fields are simply omitted.
        const state = {
            task: input.state.task,
            ...(input.state.expectedOutput ? { expectedOutput: input.state.expectedOutput } : {}),
            ...(input.state.context ? { context: input.state.context } : {}),
            agent: input.state.agent,
            preference: input.state.preference,
            candidates: input.state.candidates.map((candidate) => ({
                id: modelKey(candidate.identity),
                description: candidate.description,
                capabilities: candidate.capabilities,
                ...(candidate.limitations ? { limitations: candidate.limitations } : {}),
                provenance: candidate.provenance,
                ...(candidate.cost ? { cost: candidate.cost } : {}),
                ...(candidate.latencyMs !== undefined ? { latencyMs: candidate.latencyMs } : {}),
                ...(candidate.contextWindow !== undefined ? { contextWindow: candidate.contextWindow } : {}),
            })),
        };
        const options = {
            ...(input.signal ? { signal: input.signal } : {}),
            timeout: this.timeoutMs,
            retry: { maxRetries: 0 },
        };
        const response = await this.client.systemOne({
            state,
            model: "jev-latest",
            questions: { selected_model: choice(input.question, criteria) },
        }, options);
        const answer = response?.answers?.selected_model;
        if (!answer || typeof answer.choice !== "string")
            throw new Error("Jev returned no model choice");
        const identity = parseIdentity(answer.choice);
        // Probabilities are bounded to the requested candidate set and validated
        // as finite numbers; anything else is dropped rather than persisted (F11).
        const probabilities = isBoundedProbabilityMap(answer.probabilities, input.candidateIds);
        const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : undefined;
        return {
            identity,
            ...(probabilities ? { probabilities } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
            ...(response.usage
                ? { usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } }
                : {}),
        };
    }
}
function parseIdentity(value) {
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1)
        throw new Error(`Jev returned malformed model identity: ${value}`);
    return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
function isBoundedProbabilityMap(value, candidateIds) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const allowed = new Set(candidateIds);
    const result = {};
    let any = false;
    for (const [key, raw] of Object.entries(value)) {
        if (!allowed.has(key))
            continue; // keys outside the candidate set are dropped
        if (typeof raw !== "number" || !Number.isFinite(raw))
            continue; // invalid values are dropped
        result[key] = raw;
        any = true;
    }
    return any ? result : undefined;
}
