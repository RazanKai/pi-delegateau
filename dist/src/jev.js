import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
export class JevSelector {
    client;
    timeoutMs;
    constructor(options = {}) {
        this.client = options.client ?? new TypeSafeClient({
            timeout: options.timeoutMs ?? 2_000,
            retry: { maxRetries: 0 },
        });
        this.timeoutMs = options.timeoutMs ?? 2_000;
    }
    async choose(input) {
        const criteria = {};
        for (const candidate of input.state.candidates) {
            criteria[`${candidate.identity.provider}/${candidate.identity.id}`] = candidate.description;
        }
        const state = {
            task: input.state.task,
            ...(input.state.expectedOutput ? { expectedOutput: input.state.expectedOutput } : {}),
            ...(input.state.context ? { context: input.state.context } : {}),
            agent: input.state.agent,
            preference: input.state.preference,
            candidates: input.state.candidates.map((candidate) => ({
                id: `${candidate.identity.provider}/${candidate.identity.id}`,
                description: candidate.description,
                capabilities: candidate.capabilities,
                ...(candidate.limitations ? { limitations: candidate.limitations } : {}),
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
        return {
            identity: parseIdentity(answer.choice),
            ...(isNumberMap(answer.probabilities) ? { probabilities: answer.probabilities } : {}),
            ...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
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
function isNumberMap(value) {
    return typeof value === "object" && value !== null && Object.values(value).every((item) => typeof item === "number");
}
