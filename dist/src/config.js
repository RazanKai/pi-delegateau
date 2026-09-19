import * as fs from "node:fs";
import * as path from "node:path";
import { modelKey } from "./types.js";
const DEFAULT_LIMITS = {
    selectionDeadlineMs: 2_000,
    childWallTimeMs: 15 * 60_000,
    // 40 was too tight for real multi-file editing work: a child that needs to
    // read, edit, re-read and verify across several files can exhaust it before
    // it finishes, which surfaces as a limit-exceeded failure rather than a
    // completed assignment. Wall time remains the binding safety envelope.
    childMaxTurns: 120,
    childOutputChars: 50_000,
    maxTaskChars: 20_000,
    maxContextChars: 20_000,
    maxExpectedOutputChars: 20_000,
    maxGatePromptChars: 20_000,
    concurrency: 3,
    maxQueueDepth: 20,
};
// Tools that execute commands or mutate the repository; excluded from
// delegate-execution and the enforced "delegate" request restriction.
const MUTATION_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
// Parent-side recovery surface that stays available under a failed or
// blocked enforced decision. Kept minimal on purpose: status commands and
// the override command are always reachable; these are tool-level names only.
const KNOWN_COORDINATION_TOOLS = new Set(["read", "grep", "find", "ls"]);
const CHILD_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const DEFAULT_ALLOWED = {
    delegateExecution: ["delegate_task", "read", "grep", "find", "ls"],
    coordinatorOnly: ["delegate_task"],
};
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value, name) {
    if (typeof value !== "string" || value.trim() === "")
        throw new Error(`${name} must be a non-empty string`);
    return value.trim();
}
function readIdentity(value, name) {
    if (!isRecord(value))
        throw new Error(`${name} must be a provider/model identity`);
    return { provider: readString(value.provider, `${name}.provider`), id: readString(value.id, `${name}.id`) };
}
/**
 * Validate the cost-metering override block. Refuses unknown values rather than
 * ignoring them: a typo here would silently change which axis the chooser
 * optimises, and a wrong cost axis is the bug this whole path exists to fix.
 */
function readCostMode(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value))
        throw new Error("costMode must be an object");
    const providers = {};
    if (value.providers !== undefined) {
        if (!isRecord(value.providers))
            throw new Error("costMode.providers must be an object");
        for (const [provider, mode] of Object.entries(value.providers)) {
            if (mode !== "token" && mode !== "quota-gpu-time") {
                throw new Error(`costMode.providers.${provider} must be "token" or "quota-gpu-time"`);
            }
            providers[provider] = mode;
        }
    }
    let ollamaPlan;
    if (value.ollamaPlan !== undefined) {
        if (value.ollamaPlan !== "gpu-time" && value.ollamaPlan !== "credits") {
            throw new Error('costMode.ollamaPlan must be "gpu-time" or "credits"');
        }
        ollamaPlan = value.ollamaPlan;
    }
    if (Object.keys(providers).length === 0 && ollamaPlan === undefined)
        return undefined;
    return {
        ...(Object.keys(providers).length > 0 ? { providers } : {}),
        ...(ollamaPlan ? { ollamaPlan } : {}),
    };
}
function readCandidate(value, index) {
    if (!isRecord(value))
        throw new Error(`candidates[${index}] must be an object`);
    const identity = readIdentity(value.identity ?? value, `candidates[${index}]`);
    const description = typeof value.description === "string" ? value.description : "User-supplied model profile";
    const capabilities = Array.isArray(value.capabilities)
        ? value.capabilities.filter((item) => typeof item === "string")
        : [];
    const limitations = Array.isArray(value.limitations)
        ? value.limitations.filter((item) => typeof item === "string")
        : undefined;
    const contextWindow = value.contextWindow === undefined ? undefined : readPositiveInt(value.contextWindow, `candidates[${index}].contextWindow`, 1);
    const latencyMs = value.latencyMs === undefined ? undefined : readPositiveInt(value.latencyMs, `candidates[${index}].latencyMs`, 1);
    const cost = isRecord(value.cost)
        ? {
            ...(typeof value.cost.input === "number" && Number.isFinite(value.cost.input) && value.cost.input >= 0 ? { input: value.cost.input } : {}),
            ...(typeof value.cost.output === "number" && Number.isFinite(value.cost.output) && value.cost.output >= 0 ? { output: value.cost.output } : {}),
        }
        : undefined;
    const provenance = value.provenance === "built-in" ? "built-in" : "user";
    return {
        identity,
        description,
        capabilities,
        ...(limitations ? { limitations } : {}),
        provenance,
        ...(contextWindow ? { contextWindow } : {}),
        ...(latencyMs ? { latencyMs } : {}),
        ...(cost && Object.keys(cost).length > 0 ? { cost } : {}),
    };
}
function readPositiveInt(value, name, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer`);
    return value;
}
function readNonNegativeInt(value, name, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        throw new Error(`${name} must be a non-negative integer`);
    return value;
}
function readStringArray(value, name) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error(`${name} must be an array`);
    return [...new Set(value.map((item, index) => readString(item, `${name}[${index}]`)))];
}
function readChildTools(value, name, hasExtensions) {
    const tools = readStringArray(value, `${name}.tools`);
    const invalid = tools.filter((tool) => tool === "delegate_task" || (!CHILD_TOOLS.has(tool) && !hasExtensions));
    if (invalid.length > 0)
        throw new Error(`${name} tools are not approved child tools: ${invalid.join(", ")}`);
    return tools;
}
/**
 * Intersect a configured parent allowlist with a safe maximum. The user may
 * remove capabilities from an enforced mode but never re-admit command
 * execution or mutation tools that the mode exists to withhold.
 */
function sanitizeAllowedTools(configured, fallback, mode) {
    const base = configured.length > 0 ? configured : fallback;
    const safe = base.filter((name) => !MUTATION_TOOLS.has(name));
    if (!safe.includes("delegate_task"))
        safe.push("delegate_task");
    return [...new Set(safe)];
}
export function parseConfig(raw) {
    const input = isRecord(raw) ? raw : {};
    const selection = (input.selection ?? "fixed");
    const delegationDecision = (input.delegationDecision ?? "manual");
    const mode = (input.mode ?? "normal");
    const preference = (input.preference ?? "balanced");
    if (!["fixed", "jev"].includes(selection))
        throw new Error("selection must be fixed or jev");
    if (!["manual", "jev-suggest", "jev-enforce"].includes(delegationDecision))
        throw new Error("delegationDecision is invalid");
    if (!["normal", "delegate-execution", "coordinator-only"].includes(mode))
        throw new Error("mode is invalid");
    if (!["economy", "balanced", "quality"].includes(preference))
        throw new Error("preference is invalid");
    const candidatesRaw = input.candidates === undefined ? [] : input.candidates;
    if (!Array.isArray(candidatesRaw))
        throw new Error("candidates must be an array");
    const candidates = candidatesRaw.map(readCandidate);
    const seen = new Set();
    for (const candidate of candidates) {
        const key = modelKey(candidate.identity);
        if (seen.has(key))
            throw new Error(`Duplicate candidate: ${key}`);
        seen.add(key);
    }
    const defaultModel = input.defaultModel === undefined ? undefined : readIdentity(input.defaultModel, "defaultModel");
    const agentsInput = isRecord(input.agents) ? input.agents : {};
    const agents = {};
    for (const [name, value] of Object.entries(agentsInput)) {
        if (!isRecord(value))
            throw new Error(`agents.${name} must be an object`);
        const childExtensions = readStringArray(value.childExtensions, `agents.${name}.childExtensions`);
        const agent = {
            name,
            instructions: readString(value.instructions, `agents.${name}.instructions`),
            tools: readChildTools(value.tools, `agents.${name}`, childExtensions.length > 0),
            childExtensions,
            ...(value.model === undefined ? {} : { model: readIdentity(value.model, `agents.${name}.model`) }),
        };
        agents[name] = agent;
    }
    const pinsInput = isRecord(input.agentPins) ? input.agentPins : {};
    const agentPins = {};
    for (const [agent, identity] of Object.entries(pinsInput))
        agentPins[readString(agent, "agent pin name")] = readIdentity(identity, `agentPins.${agent}`);
    const limitsInput = isRecord(input.limits) ? input.limits : {};
    const limits = {
        selectionDeadlineMs: readPositiveInt(limitsInput.selectionDeadlineMs, "selectionDeadlineMs", DEFAULT_LIMITS.selectionDeadlineMs),
        childWallTimeMs: readPositiveInt(limitsInput.childWallTimeMs, "childWallTimeMs", DEFAULT_LIMITS.childWallTimeMs),
        childMaxTurns: readPositiveInt(limitsInput.childMaxTurns, "childMaxTurns", DEFAULT_LIMITS.childMaxTurns),
        childOutputChars: readPositiveInt(limitsInput.childOutputChars, "childOutputChars", DEFAULT_LIMITS.childOutputChars),
        maxTaskChars: readPositiveInt(limitsInput.maxTaskChars, "maxTaskChars", DEFAULT_LIMITS.maxTaskChars),
        maxContextChars: readPositiveInt(limitsInput.maxContextChars, "maxContextChars", DEFAULT_LIMITS.maxContextChars),
        maxExpectedOutputChars: readPositiveInt(limitsInput.maxExpectedOutputChars, "maxExpectedOutputChars", DEFAULT_LIMITS.maxExpectedOutputChars),
        maxGatePromptChars: readPositiveInt(limitsInput.maxGatePromptChars, "maxGatePromptChars", DEFAULT_LIMITS.maxGatePromptChars),
        concurrency: readPositiveInt(limitsInput.concurrency, "concurrency", DEFAULT_LIMITS.concurrency),
        maxQueueDepth: readNonNegativeInt(limitsInput.maxQueueDepth, "maxQueueDepth", DEFAULT_LIMITS.maxQueueDepth),
    };
    const allowedInput = isRecord(input.allowedParentTools) ? input.allowedParentTools : {};
    const readTools = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
    const childThinking = input.childThinking === undefined ? undefined : readString(input.childThinking, "childThinking");
    if (childThinking !== undefined && !THINKING_LEVELS.includes(childThinking)) {
        throw new Error(`childThinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
    // Cost-metering overrides. Kept small and validated: a typo here would silently
    // change which axis the chooser optimises, which is worse than refusing to load.
    const costMode = readCostMode(input.costMode);
    return {
        selection,
        delegationDecision,
        mode,
        preference,
        candidates,
        ...(defaultModel ? { defaultModel } : {}),
        agentPins,
        agents,
        allowExternalSensing: input.allowExternalSensing !== false,
        allowedParentTools: {
            delegateExecution: sanitizeAllowedTools(readTools(allowedInput.delegateExecution), DEFAULT_ALLOWED.delegateExecution, "delegate-execution"),
            coordinatorOnly: sanitizeAllowedTools(readTools(allowedInput.coordinatorOnly), DEFAULT_ALLOWED.coordinatorOnly, "coordinator-only"),
        },
        limits,
        ...(childThinking ? { childThinking } : {}),
        ...(costMode ? { costMode } : {}),
        ...(typeof input.receiptPath === "string" && input.receiptPath ? { receiptPath: input.receiptPath } : {}),
        ...(typeof input.decisionReceiptPath === "string" && input.decisionReceiptPath ? { decisionReceiptPath: input.decisionReceiptPath } : {}),
        ...(typeof input.piCommand === "string" && input.piCommand ? { piCommand: input.piCommand } : {}),
    };
}
export { DEFAULT_LIMITS, KNOWN_COORDINATION_TOOLS, MUTATION_TOOLS, CHILD_TOOLS };
export const CONFIG_FILE_NAME = ".pi/delegateau.json";
export function loadConfig(cwd) {
    const configPath = path.join(cwd, CONFIG_FILE_NAME);
    if (!fs.existsSync(configPath))
        return parseConfig({});
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
    catch (error) {
        throw new Error(`Unable to read ${CONFIG_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseConfig(raw);
}
