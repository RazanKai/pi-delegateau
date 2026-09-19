import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { describeCostSignal, resolveCostSignal } from "./quota.js";
import { modelKey } from "./types.js";
export class JevSelector {
    client;
    timeoutMs;
    /** Measured quota coefficients for quota-metered providers, if any exist. */
    quotaStore;
    /** Per-provider metering overrides from config. */
    costModeConfig;
    /**
     * Client construction is defensive (F01 class): a missing API key or
     * transport failure becomes a normal choose() error inside the selection
     * deadline/fallback logic instead of a constructor throw outside it.
     */
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs ?? 2_000;
        this.quotaStore = options.quotaStore;
        this.costModeConfig = options.costModeConfig;
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
            const key = `${candidate.identity.provider}/${candidate.identity.id}`;
            // The criterion is the description PLUS the facts the provider published,
            // because prose alone is what let a model be chosen for "large reasoning"
            // on a claim nobody verified, while its real price went unread. A price
            // is labelled with its provenance so a config-authored guess is never
            // presented as the catalog's own number.
            const facts = [candidate.description];
            // Cost is resolved by the provider's METERING model, not by price alone.
            // On a quota-metered subscription the published price is not the axis that
            // runs out, and using it ranks the plan's most expensive model as the
            // cheapest (measured: glm-5.3-flash has half the price of
            // deepseek-v4.1-flash and ~3.5x the quota cost).
            facts.push(describeCostSignal(resolveCostSignal(candidate.identity, candidate, {
                ...(this.quotaStore ? { quotaStore: this.quotaStore } : {}),
                ...(this.costModeConfig ? { costModeConfig: this.costModeConfig } : {}),
            })));
            if (candidate.contextWindow !== undefined)
                facts.push(`context ${Math.round(candidate.contextWindow / 1000)}K`);
            if (candidate.maxOutputTokens !== undefined)
                facts.push(`max output ${Math.round(candidate.maxOutputTokens / 1000)}K`);
            if (candidate.reasoning !== undefined)
                facts.push(candidate.reasoning ? "reasoning-capable" : "no reasoning mode");
            if (candidate.inputModalities && candidate.inputModalities.length > 0)
                facts.push(`accepts ${candidate.inputModalities.join("+")}`);
            criteria[key] = facts.join(" | ");
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
