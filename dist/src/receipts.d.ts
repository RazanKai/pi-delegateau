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
export type ReceiptErrorCategory = "credential-missing" | "timeout" | "invalid-response" | "cancelled" | "sensing-prohibited" | "budget" | "quota" | "connection" | "sensor-error";
/**
 * A failure that already knows which category it is. Thrown by transport
 * adapters that have the structure in hand, so classification does not have to
 * recover it from prose. `code` is deliberately the same vocabulary as
 * `ReceiptErrorCategory` so receipts need no translation.
 */
export declare class ReceiptError extends Error {
    readonly code: ReceiptErrorCategory;
    readonly status?: number | undefined;
    constructor(code: ReceiptErrorCategory, message: string, status?: number);
}
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
/**
 * Categorize a failure from whatever it is, preferring structure over text.
 *
 * A transport error usually knows exactly what went wrong: the SDK's errors
 * carry an HTTP status (`APIError.status`), a timeout carries its own class,
 * and an abort carries `AbortError`. Reading those is exact; reading the
 * message is a guess. The order below is therefore specificity first, prose
 * last — which is what makes a local deadline, a provider timeout and a
 * refused credential distinguishable at all, since all three are spelled
 * "timeout" or "authentication" in a sentence.
 */
export declare function classifyFailure(error: unknown): ReceiptErrorCategory | undefined;
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
