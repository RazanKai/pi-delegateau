import type { DelegationDecision, ExecutionOutcome, GateRestriction, GateSource, GateStatus } from "./gate.js";
import type { ChildResult } from "./types.js";
import type { DelegationPolicy, DelegationMode, ModelIdentity, SelectionSource } from "./types.js";
import { modelKey } from "./types.js";

export interface ReceiptInput {
  dispatchId: string;
  decisionId?: string | undefined;
  agent: string;
  identity?: ModelIdentity;
  servedModel?: ModelIdentity;
  requestedModel?: ModelIdentity;
  source?: SelectionSource;
  preference: string;
  eligibleIds: string[];
  profileVersion: string;
  outcome: string;
  task?: string;
  expectedOutput?: string;
  context?: string;
  selectionProbabilities?: Record<string, number>;
  confidence?: number;
  chooserLatencyMs?: number;
  fallbackCause?: string;
  usage?: { chooser?: unknown; child?: unknown };
  errorCategory?: string;
  groupCleaned?: boolean;
  outputTruncated?: boolean;
}

export type ReceiptErrorCategory =
  | "credential-missing"
  | "timeout"
  | "invalid-response"
  | "cancelled"
  | "sensing-prohibited"
  | "sensor-error";

export type Receipt = Omit<ReceiptInput, "task" | "expectedOutput" | "context" | "fallbackCause"> & {
  fallbackCause?: ReceiptErrorCategory;
};

export interface DecisionReceiptInput {
  decisionId: string;
  generation: number;
  policy: DelegationPolicy;
  baseMode: DelegationMode;
  source: GateSource;
  status: GateStatus;
  restriction: GateRestriction;
  recommendation?: "local" | "delegate";
  childAvailable: boolean;
  eligibleChildIds: string[];
  childAgentNames: string[];
  execution: ExecutionOutcome;
  outcome: string;
  reason?: string;
  invalidationReason?: string;
  override?: "local" | "delegate" | "manual";
  confidence?: number;
  latencyMs?: number;
  usage?: unknown;
}

export type DecisionReceipt = Omit<DecisionReceiptInput, "reason" | "invalidationReason"> & {
  reason?: ReceiptErrorCategory;
  invalidationReason?: ReceiptErrorCategory;
};

// Error classification persisted instead of raw remote text. Gate/chooser
// failures are categorized; the raw service message never reaches receipts
// because it can echo private prompt content (F08).
const ERROR_CATEGORIES: ReadonlyArray<[RegExp, ReceiptErrorCategory]> = [
  [/no api key|api key|credentials|credential|auth/i, "credential-missing"],
  [/deadline|timeout|timed?\s*out/i, "timeout"],
  [/invalid|malformed|no valid|unexpected|must be/i, "invalid-response"],
  [/cancel/i, "cancelled"],
  [/prohibited/i, "sensing-prohibited"],
];

export function classifyError(message: string): ReceiptErrorCategory;
export function classifyError(message: undefined): undefined;
export function classifyError(message: string | undefined): ReceiptErrorCategory | undefined;
export function classifyError(message: string | undefined): ReceiptErrorCategory | undefined {
  if (!message) return undefined;
  for (const [pattern, category] of ERROR_CATEGORIES) {
    if (pattern.test(message)) return category;
  }
  return "sensor-error";
}

export function buildDecisionReceipt(decision: DelegationDecision, outcome: string): DecisionReceipt {
  return {
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
    ...(decision.reason ? { reason: classifyError(decision.reason) } : {}),
    ...(decision.invalidationReason ? { invalidationReason: classifyError(decision.invalidationReason) } : {}),
    ...(decision.override ? { override: decision.override } : {}),
    ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
    ...(decision.latencyMs !== undefined ? { latencyMs: decision.latencyMs } : {}),
    ...(decision.usage ? { usage: decision.usage } : {}),
  };
}

/**
 * Sanitize an error message for display. NOTE: this is for transient UI text
 * only; persistent receipts must use classifyError() so remote bodies that
 * may echo private prompts never reach disk (F08).
 */
export function sanitizeError(message: string, secrets: string[] = []): string {
  let result = message.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");
  for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
  return result.slice(0, 2_000);
}

export function buildReceipt(input: ReceiptInput): Receipt {
  const { task: _task, expectedOutput: _expectedOutput, context: _context, fallbackCause, ...safe } = input;
  return {
    ...safe,
    ...(fallbackCause ? { fallbackCause: classifyError(fallbackCause) } : {}),
  };
}

/** Build a short human-readable dispatch summary including served-model evidence. */
export function dispatchSummary(result: ChildResult, selectionSource: SelectionSource, requested: ModelIdentity): string {
  const applied = modelKey(result.appliedModel);
  const requestedKey = modelKey(requested);
  const served = result.servedModel ? modelKey(result.servedModel) : undefined;
  const substitution = served && served !== applied ? `\nProvider served model evidence: ${served}` : "";
  return applied === requestedKey
    ? `${selectionSource} (${applied})${substitution}`
    : `${selectionSource} (requested ${requestedKey}, applied ${applied})${substitution}`;
}