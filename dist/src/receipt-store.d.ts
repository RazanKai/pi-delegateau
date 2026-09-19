import type { DecisionReceipt, Receipt } from "./receipts.js";
export declare function newDispatchId(): string;
export declare function defaultReceiptPath(): string;
export declare function defaultDecisionReceiptPath(): string;
export declare function appendReceipt(filePath: string, receipt: Receipt | DecisionReceipt): Promise<void>;
