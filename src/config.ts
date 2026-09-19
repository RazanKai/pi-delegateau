import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CandidateProfile,
  DelegationMode,
  DelegateConfig,
  DelegateLimits,
  ModelIdentity,
  RoutingPreference,
  SelectionMode,
  TrustedAgent,
} from "./types.js";
import { modelKey } from "./types.js";

const DEFAULT_LIMITS: DelegateLimits = {
  selectionDeadlineMs: 2_000,
  childWallTimeMs: 15 * 60_000,
  childMaxTurns: 40,
  childOutputChars: 50_000,
  maxTaskChars: 20_000,
  maxContextChars: 20_000,
};

const DEFAULT_ALLOWED = {
  delegateExecution: ["delegate_task", "read", "search"],
  coordinatorOnly: ["delegate_task", "ask_user"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function readIdentity(value: unknown, name: string): ModelIdentity {
  if (!isRecord(value)) throw new Error(`${name} must be a provider/model identity`);
  return { provider: readString(value.provider, `${name}.provider`), id: readString(value.id, `${name}.id`) };
}

function readCandidate(value: unknown, index: number): CandidateProfile {
  if (!isRecord(value)) throw new Error(`candidates[${index}] must be an object`);
  const identity = readIdentity(value.identity ?? value, `candidates[${index}]`);
  const description = typeof value.description === "string" ? value.description : "User-supplied model profile";
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const limitations = Array.isArray(value.limitations)
    ? value.limitations.filter((item): item is string => typeof item === "string")
    : undefined;
  const provenance = value.provenance === "built-in" ? "built-in" : "user";
  return { identity, description, capabilities, ...(limitations ? { limitations } : {}), provenance };
}

function readPositiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseConfig(raw: unknown): DelegateConfig {
  const input = isRecord(raw) ? raw : {};
  const selection = (input.selection ?? "fixed") as SelectionMode;
  const mode = (input.mode ?? "normal") as DelegationMode;
  const preference = (input.preference ?? "balanced") as RoutingPreference;
  if (!(["fixed", "jev"] as string[]).includes(selection)) throw new Error("selection must be fixed or jev");
  if (!( ["normal", "delegate-execution", "coordinator-only"] as string[]).includes(mode)) throw new Error("mode is invalid");
  if (!( ["economy", "balanced", "quality"] as string[]).includes(preference)) throw new Error("preference is invalid");

  const candidatesRaw = input.candidates === undefined ? [] : input.candidates;
  if (!Array.isArray(candidatesRaw)) throw new Error("candidates must be an array");
  const candidates = candidatesRaw.map(readCandidate);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = modelKey(candidate.identity);
    if (seen.has(key)) throw new Error(`Duplicate candidate: ${key}`);
    seen.add(key);
  }

  const defaultModel = input.defaultModel === undefined ? undefined : readIdentity(input.defaultModel, "defaultModel");
  const agentsInput = isRecord(input.agents) ? input.agents : {};
  const agents: Record<string, TrustedAgent> = {};
  for (const [name, value] of Object.entries(agentsInput)) {
    if (!isRecord(value)) throw new Error(`agents.${name} must be an object`);
    const tools = Array.isArray(value.tools)
      ? value.tools.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const agent: TrustedAgent = {
      name,
      instructions: readString(value.instructions, `agents.${name}.instructions`),
      tools,
      ...(value.model === undefined ? {} : { model: readIdentity(value.model, `agents.${name}.model`) }),
    };
    agents[name] = agent;
  }
  const pinsInput = isRecord(input.agentPins) ? input.agentPins : {};
  const agentPins: Record<string, ModelIdentity> = {};
  for (const [agent, identity] of Object.entries(pinsInput)) agentPins[readString(agent, "agent pin name")] = readIdentity(identity, `agentPins.${agent}`);

  const limitsInput = isRecord(input.limits) ? input.limits : {};
  const limits: DelegateLimits = {
    selectionDeadlineMs: readPositiveInt(limitsInput.selectionDeadlineMs, "selectionDeadlineMs", DEFAULT_LIMITS.selectionDeadlineMs),
    childWallTimeMs: readPositiveInt(limitsInput.childWallTimeMs, "childWallTimeMs", DEFAULT_LIMITS.childWallTimeMs),
    childMaxTurns: readPositiveInt(limitsInput.childMaxTurns, "childMaxTurns", DEFAULT_LIMITS.childMaxTurns),
    childOutputChars: readPositiveInt(limitsInput.childOutputChars, "childOutputChars", DEFAULT_LIMITS.childOutputChars),
    maxTaskChars: readPositiveInt(limitsInput.maxTaskChars, "maxTaskChars", DEFAULT_LIMITS.maxTaskChars),
    maxContextChars: readPositiveInt(limitsInput.maxContextChars, "maxContextChars", DEFAULT_LIMITS.maxContextChars),
  };

  const allowedInput = isRecord(input.allowedParentTools) ? input.allowedParentTools : {};
  const readTools = (value: unknown, fallback: string[]) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : fallback;

  return {
    selection,
    mode,
    preference,
    candidates,
    ...(defaultModel ? { defaultModel } : {}),
    agentPins,
    agents,
    allowExternalSensing: input.allowExternalSensing !== false,
    allowedParentTools: {
      delegateExecution: readTools(allowedInput.delegateExecution, DEFAULT_ALLOWED.delegateExecution),
      coordinatorOnly: readTools(allowedInput.coordinatorOnly, DEFAULT_ALLOWED.coordinatorOnly),
    },
    limits,
    ...(typeof input.receiptPath === "string" && input.receiptPath ? { receiptPath: input.receiptPath } : {}),
  };
}

export { DEFAULT_LIMITS };

export const CONFIG_FILE_NAME = ".pi/delegateau.json";

export function loadConfig(cwd: string): DelegateConfig {
  const configPath = path.join(cwd, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) return parseConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${CONFIG_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(raw);
}
