import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
export function newDispatchId() {
    return randomUUID();
}
export function defaultReceiptPath() {
    const root = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? ".", ".pi", "agent");
    return path.join(root, "delegateau", "receipts.jsonl");
}
export async function appendReceipt(filePath, receipt) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.appendFile(filePath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
}
