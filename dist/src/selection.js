import { modelKey, sameModel, } from "./types.js";
const CHOICE_QUESTION = "Which eligible model best fits this assignment under the supplied routing preference and candidate profiles?";
function abortError() {
    return Object.assign(new Error("The delegation was cancelled"), { name: "AbortError" });
}
function findCandidate(request, identity) {
    return request.candidates.find((candidate) => sameModel(candidate.identity, identity));
}
function requireDefault(request) {
    if (!request.defaultModel)
        throw new Error("No eligible models and no configured eligible default");
    if (!findCandidate(request, request.defaultModel))
        throw new Error(`Configured default ${modelKey(request.defaultModel)} is not eligible`);
    return request.defaultModel;
}
function validateRequest(request) {
    if (!request.task.trim())
        throw new Error("Task must not be empty");
    const seen = new Set();
    for (const candidate of request.candidates) {
        const key = modelKey(candidate.identity);
        if (seen.has(key))
            throw new Error(`Duplicate candidate: ${key}`);
        seen.add(key);
    }
    if (request.selectionDeadlineMs !== undefined && request.selectionDeadlineMs <= 0) {
        throw new Error("selectionDeadlineMs must be positive");
    }
}
/**
 * Side-effect-free resolution of the launch model for a request, exactly as
 * dispatch will apply it: pin -> fixed -> single-candidate -> jev -> fallback.
 * The gate uses this to decide child availability, so its notion of "a usable
 * child exists" matches what delegate_task can actually launch (F09).
 */
export function resolveLaunchModel(request, choose) {
    const agent = request.agent;
    if (agent.model) {
        return findCandidate(request, agent.model) ? agent.model : undefined;
    }
    if (request.selectionMode === "fixed" || !request.allowExternalSensing) {
        if (!request.defaultModel)
            return request.candidates.length > 0 ? request.candidates[0].identity : undefined;
        return findCandidate(request, request.defaultModel) ? request.defaultModel : undefined;
    }
    if (request.candidates.length === 0)
        return request.defaultModel && findCandidate(request, request.defaultModel) ? request.defaultModel : undefined;
    if (request.candidates.length === 1)
        return request.candidates[0].identity;
    // Jev mode with multiple candidates: availability requires a resolvable
    // chooser AND an eligible fallback/default for sensor failures.
    if (typeof choose !== "function")
        return undefined;
    if (request.defaultModel && findCandidate(request, request.defaultModel))
        return request.defaultModel;
    return undefined;
}
async function chooseWithDeadline(request, runtime) {
    const controller = new AbortController();
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Jev selection deadline exceeded"));
        }, request.selectionDeadlineMs ?? 2_000);
    });
    const onAbort = () => controller.abort();
    runtime.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        if (runtime.signal?.aborted)
            throw abortError();
        const choicePromise = runtime.choose({
            state: {
                task: request.task,
                ...(request.expectedOutput ? { expectedOutput: request.expectedOutput } : {}),
                ...(request.context ? { context: request.context } : {}),
                agent: { name: request.agent.name, instructions: request.agent.instructions, tools: [...request.agent.tools] },
                preference: request.preference,
                candidates: request.candidates.map((candidate) => ({
                    ...candidate,
                    identity: { ...candidate.identity },
                    capabilities: [...candidate.capabilities],
                    ...(candidate.limitations ? { limitations: [...candidate.limitations] } : {}),
                })),
            },
            candidateIds: request.candidates.map((candidate) => modelKey(candidate.identity)),
            question: CHOICE_QUESTION,
            signal: controller.signal,
        });
        return await Promise.race([choicePromise, timeoutPromise]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        runtime.signal?.removeEventListener("abort", onAbort);
    }
}
export async function selectModel(request, runtime) {
    validateRequest(request);
    const started = performance.now();
    const pin = request.agent.model;
    if (pin) {
        if (!findCandidate(request, pin))
            throw new Error(`Trusted pin ${modelKey(pin)} is not eligible`);
        return { identity: pin, source: "pin" };
    }
    if (request.selectionMode === "fixed" || !request.allowExternalSensing) {
        return { identity: requireDefault(request), source: "fixed" };
    }
    if (request.candidates.length === 0)
        throw new Error("No eligible models");
    if (request.candidates.length === 1)
        return { identity: request.candidates[0].identity, source: "single-candidate" };
    if (runtime.signal?.aborted)
        throw abortError();
    try {
        const answer = await chooseWithDeadline(request, runtime);
        if (runtime.signal?.aborted)
            throw abortError();
        if (!answer || !findCandidate(request, answer.identity)) {
            throw new Error(`Jev selection ${answer?.identity ? modelKey(answer.identity) : "(missing)"} is not eligible`);
        }
        return {
            identity: answer.identity,
            source: "jev",
            ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
            ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
            ...(answer.usage ? { usage: answer.usage } : {}),
            chooserLatencyMs: Math.round(performance.now() - started),
        };
    }
    catch (error) {
        if (runtime.signal?.aborted)
            throw abortError();
        const fallback = requireDefault(request);
        return {
            identity: fallback,
            source: "fallback",
            cause: error instanceof Error ? error.message : "Jev selection failed",
            chooserLatencyMs: Math.round(performance.now() - started),
        };
    }
}
export { CHOICE_QUESTION };
