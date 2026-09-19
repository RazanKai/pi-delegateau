import type { Receipt } from "./receipts.js";
export declare function newDispatchId(): string;
export declare function defaultReceiptPath(): string;
export declare function appendReceipt(filePath: string, receipt: Receipt): Promise<void>;
