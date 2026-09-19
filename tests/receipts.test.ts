import { describe, expect, it } from "vitest";
import { buildReceipt, sanitizeError } from "../src/receipts.js";

describe("receipts", () => {
  it("contains routing metadata but no private payloads", () => {
    const receipt = buildReceipt({
      dispatchId: "d-1",
      agent: "worker",
      identity: { provider: "alpha", id: "fast" },
      source: "jev",
      preference: "balanced",
      eligibleIds: ["alpha/fast"],
      profileVersion: "v1",
      outcome: "success",
      task: "SECRET TASK",
      selectionProbabilities: { "alpha/fast": 1 },
    });
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain("SECRET TASK");
    expect(receipt).toMatchObject({ dispatchId: "d-1", source: "jev", outcome: "success" });
  });

  it("sanitizes provider error bodies", () => {
    expect(sanitizeError("token=SECRET\nprovider failed", ["SECRET"])).toBe("token=[redacted]\nprovider failed");
  });
});
