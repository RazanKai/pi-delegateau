import { describe, expect, it } from "vitest";
import { DelegationGate } from "../src/gate.js";
import { buildDecisionReceipt, buildReceipt, classifyError, dispatchSummary, sanitizeError } from "../src/receipts.js";

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
      expectedOutput: "SECRET EXPECTED OUTPUT",
      context: "SECRET CONTEXT",
      selectionProbabilities: { "alpha/fast": 1 },
    });
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain("SECRET TASK");
    expect(encoded).not.toContain("SECRET EXPECTED OUTPUT");
    expect(encoded).not.toContain("SECRET CONTEXT");
    expect(receipt).toMatchObject({ dispatchId: "d-1", source: "jev", outcome: "success" });
  });

  it("classifies dispatch fallback causes inside the receipt builder", () => {
    const receipt = buildReceipt({
      dispatchId: "d-fallback",
      agent: "worker",
      preference: "balanced",
      eligibleIds: ["alpha/fast"],
      profileVersion: "v1",
      outcome: "success",
      fallbackCause: "Request timed out after 200ms. REMOTE-DISPATCH-BODY",
    });
    expect(receipt.fallbackCause).toBe("timeout");
    expect(JSON.stringify(receipt)).not.toContain("REMOTE-DISPATCH-BODY");
  });

  it("records request decisions without the prompt body and keeps execution outcome separate", async () => {
    const decision = await new DelegationGate().ensure({
      prompt: "PRIVATE TASK BODY",
      policy: "jev-suggest",
      baseMode: "normal",
      baseTools: ["read", "write", "delegate_task"],
      preference: "balanced",
      parent: { capabilities: ["code"] },
      candidates: [{ identity: { provider: "child", id: "model" }, description: "child", capabilities: ["code"], provenance: "user" }],
      childAvailable: true,
      childAgentNames: ["worker"],
      allowExternalSensing: false,
      deadlineMs: 100,
      maxGatePromptChars: 20_000,
    });
    const receipt = buildDecisionReceipt(decision, "no-execution");
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE TASK BODY");
    expect(receipt).toMatchObject({ policy: "jev-suggest", outcome: "no-execution", execution: "none" });
  });

  // F08 regression: a service error that echoes private prompt text is
  // classified, never persisted raw.
  it("classifies gate failure reasons instead of persisting raw service text", async () => {
    const decision = await new DelegationGate().ensure({
      prompt: "Do this: PRIVATE-PROMPT-CONTENT refactor the billing rotation",
      policy: "jev-enforce",
      baseMode: "normal",
      baseTools: ["read", "write", "delegate_task"],
      preference: "balanced",
      parent: { capabilities: [] },
      candidates: [{ identity: { provider: "child", id: "m" }, description: "d", capabilities: [], provenance: "user" }],
      childAvailable: true,
      childAgentNames: ["worker"],
      allowExternalSensing: true,
      deadlineMs: 100,
      maxGatePromptChars: 20_000,
    }, { choose: async () => { throw new Error(`422 body.questions.recommendation: prompt must be <= 500 chars; received PRIVATE-PROMPT-CONTENT: refactor the billing rotation script`); } });
    const receipt = buildDecisionReceipt(decision, "decision");
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain("PRIVATE-PROMPT-CONTENT");
    expect(encoded).not.toContain("billing rotation");
    expect(receipt.reason).toBe("invalid-response");
  });

  // F08 sibling regression: the invalidation persistence path must be
  // categorized like the gate-failure reason path, never persisted raw.
  it("classifies invalidation reasons instead of persisting raw service text", async () => {
    const gate = new DelegationGate();
    await gate.ensure({
      prompt: "Do this: private task detail refactor the billing rotation",
      policy: "jev-suggest",
      baseMode: "normal",
      baseTools: ["read", "write", "delegate_task"],
      preference: "balanced",
      parent: { capabilities: ["code"] },
      candidates: [{ identity: { provider: "child", id: "m" }, description: "d", capabilities: ["code"], provenance: "user" }],
      childAvailable: true,
      childAgentNames: ["worker"],
      allowExternalSensing: true,
      deadlineMs: 100,
      maxGatePromptChars: 20_000,
    }, { choose: async () => ({ recommendation: "local" }) });
    const decision = gate.invalidate(
      "422 body.questions.recommendation: REMOTE-PROMPT-ECHO prompt must include private task detail before refactoring the billing rotation script",
    );
    const receipt = buildDecisionReceipt(decision!, "decision");
    const categories = new Set(["credential-missing", "timeout", "invalid-response", "cancelled", "sensing-prohibited", "sensor-error"]);
    expect(categories.has(receipt.reason!)).toBe(true);
    expect(categories.has(receipt.invalidationReason!)).toBe(true);
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain("REMOTE-PROMPT-ECHO");
    expect(encoded).not.toContain("private task detail");
  });

  it("classifies credential, timeout and cancellation errors", () => {
    expect(classifyError("No API key was provided. Pass apiKey or set TYPESAFE_API_KEY.")).toBe("credential-missing");
    expect(classifyError("Delegation decision deadline exceeded")).toBe("timeout");
    expect(classifyError("The delegation decision was cancelled")).toBe("cancelled");
    expect(classifyError("some other failure")).toBe("sensor-error");
    expect(classifyError(undefined)).toBeUndefined();
  });

  it("sanitizes provider error bodies", () => {
    expect(sanitizeError("token=SECRET\nprovider failed", ["SECRET"])).toBe("token=[redacted]\nprovider failed");
  });

  // F06 regression: dispatch summaries disclose served-model evidence.
  it("discloses served-model substitution in dispatch summaries", () => {
    const summary = dispatchSummary(
      {
        status: "success",
        output: "",
        appliedModel: { provider: "alpha", id: "requested" },
        requestedModel: { provider: "alpha", id: "requested" },
        servedModel: { provider: "omega", id: "served-cheap" },
        diagnostics: [],
        observedExit: true,
      },
      "fixed",
      { provider: "alpha", id: "requested" },
    );
    expect(summary).toContain("omega/served-cheap");
  });

  it("omits served-model line when no served evidence exists", () => {
    const summary = dispatchSummary(
      {
        status: "success",
        output: "",
        appliedModel: { provider: "alpha", id: "m" },
        requestedModel: { provider: "alpha", id: "m" },
        diagnostics: [],
        observedExit: true,
      },
      "fixed",
      { provider: "alpha", id: "m" },
    );
    expect(summary).not.toContain("served");
  });
});