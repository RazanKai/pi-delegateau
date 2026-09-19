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
export function defaultDecisionReceiptPath() {
    const root = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? ".", ".pi", "agent");
    return path.join(root, "delegateau", "decisions.jsonl");
}
export async function appendReceipt(filePath, receipt) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // Enforce the restrictive mode on every append, not only at creation: an
    // existing world-readable file must not stay world-readable (F11-adjacent).
    try {
        await fs.chmod(filePath, 0o600);
    }
    catch {
        // File may not exist yet; appendFile's creation mode applies.
    }
    await fs.appendFile(filePath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
}
