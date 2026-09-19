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
  usage?: { chooser?: unknown; child?: unknown };
  errorCategory?: string;
}

export type Receipt = Omit<ReceiptInput, "task">;

export function sanitizeError(message: string, secrets: string[] = []): string {
  let result = message.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");
  for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
  return result.slice(0, 2_000);
}

export function buildReceipt(input: ReceiptInput): Receipt {
  const { task: _task, ...safe } = input;
  return JSON.parse(JSON.stringify(safe)) as Receipt;
}
