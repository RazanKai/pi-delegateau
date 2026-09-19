import type { ModelIdentity, SelectionSource } from "./types.js";
export interface ReceiptInput {
    dispatchId: string;
    agent: string;
    identity?: ModelIdentity;
    source?: SelectionSource;
    preference: string;
    eligibleIds: string[];
    profileVersion: string;
    outcome: string;
    task?: string;
    selectionProbabilities?: Record<string, number>;
    confidence?: number;
    chooserLatencyMs?: number;
    usage?: {
        chooser?: unknown;
        child?: unknown;
    };
    errorCategory?: string;
}
export type Receipt = Omit<ReceiptInput, "task">;
export declare function sanitizeError(message: string, secrets?: string[]): string;
export declare function buildReceipt(input: ReceiptInput): Receipt;
