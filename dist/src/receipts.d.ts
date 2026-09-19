import type { DelegationDecision, ExecutionOutcome, GateRestriction, GateSource, GateStatus } from "./gate.js";
import type { ChildResult } from "./types.js";
import type { DelegationPolicy, DelegationMode, ModelIdentity, SelectionSource } from "./types.js";
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
    usage?: {
        chooser?: unknown;
        child?: unknown;
    };
    errorCategory?: string;
    groupCleaned?: boolean;
    outputTruncated?: boolean;
}
export type ReceiptErrorCategory = "credential-missing" | "timeout" | "invalid-response" | "cancelled" | "sensing-prohibited" | "sensor-error";
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
export declare function classifyError(message: string): ReceiptErrorCategory;
export declare function classifyError(message: undefined): undefined;
export declare function classifyError(message: string | undefined): ReceiptErrorCategory | undefined;
export declare function buildDecisionReceipt(decision: DelegationDecision, outcome: string): DecisionReceipt;
/**
 * Sanitize an error message for display. NOTE: this is for transient UI text
 * only; persistent receipts must use classifyError() so remote bodies that
 * may echo private prompts never reach disk (F08).
 */
export declare function sanitizeError(message: string, secrets?: string[]): string;
export declare function buildReceipt(input: ReceiptInput): Receipt;
/** Build a short human-readable dispatch summary including served-model evidence. */
export declare function dispatchSummary(result: ChildResult, selectionSource: SelectionSource, requested: ModelIdentity): string;
