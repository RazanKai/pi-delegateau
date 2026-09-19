import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("configuration", () => {
  it("rejects duplicate candidate identities and non-finite limits", () => {
    expect(() => parseConfig({ candidates: [{ provider: "a", id: "x" }, { provider: "a", id: "x" }] })).toThrow(
      "Duplicate candidate",
    );
    expect(() => parseConfig({ limits: { selectionDeadlineMs: 0 } })).toThrow("selectionDeadlineMs");
  });

  it("defaults to safe normal fixed behavior and bounded limits", () => {
    expect(parseConfig({})).toMatchObject({ selection: "fixed", delegationDecision: "manual", mode: "normal", preference: "balanced" });
    expect(parseConfig({}).limits.childOutputChars).toBeGreaterThan(0);
    expect(parseConfig({}).limits.maxGatePromptChars).toBeGreaterThan(0);
    expect(parseConfig({}).limits.maxExpectedOutputChars).toBeGreaterThan(0);
    expect(parseConfig({}).limits).toMatchObject({ concurrency: 3, maxQueueDepth: 20 });
  });

  it("validates the request gate policy and preserves model profile metadata", () => {
    expect(() => parseConfig({ delegationDecision: "unknown" })).toThrow("delegationDecision");
    expect(parseConfig({ delegationDecision: "jev-enforce", candidates: [{ provider: "a", id: "x", contextWindow: 1000, latencyMs: 20, cost: { input: 1, output: 2 } }] })).toMatchObject({
      delegationDecision: "jev-enforce",
      candidates: [{ contextWindow: 1000, latencyMs: 20, cost: { input: 1, output: 2 } }],
    });
  });

  it("rejects mutation tools re-admitted through configured parent allowlists", () => {
    // F06/F07 class: a user allowlist may not re-admit bash/write into an
    // enforced mode whose purpose is to withhold direct execution.
    const widened = parseConfig({ allowedParentTools: { delegateExecution: ["delegate_task", "bash", "write"] } });
    expect(widened.allowedParentTools.delegateExecution).not.toContain("bash");
    expect(widened.allowedParentTools.delegateExecution).not.toContain("write");
    expect(widened.allowedParentTools.delegateExecution).toContain("delegate_task");
  });

  it("rejects child agents with unapproved tools", () => {
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["bash", "shell"] } } })).toThrow("not approved child tools");
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["read", "delegate_task"] } } })).toThrow("delegate_task");
  });

  it("accepts extension tools only with an explicit per-agent extension allowlist", () => {
    expect(parseConfig({ agents: { worker: { instructions: "i", tools: ["read", "lens_diagnostics"], childExtensions: ["pi-lens"] } } }).agents.worker).toMatchObject({
      tools: ["read", "lens_diagnostics"],
      childExtensions: ["pi-lens"],
    });
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["lens_diagnostics"] } } })).toThrow("not approved child tools");
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["read"], childExtensions: "pi-lens" } } })).toThrow("childExtensions must be an array");
  });

  it("validates pool limits", () => {
    expect(parseConfig({ limits: { concurrency: 2, maxQueueDepth: 0 } }).limits).toMatchObject({ concurrency: 2, maxQueueDepth: 0 });
    expect(() => parseConfig({ limits: { concurrency: 0 } })).toThrow("concurrency");
    expect(() => parseConfig({ limits: { maxQueueDepth: -1 } })).toThrow("maxQueueDepth");
  });

  it("accepts an explicit child thinking level and rejects invalid ones", () => {
    expect(parseConfig({ childThinking: "low" }).childThinking).toBe("low");
    expect(() => parseConfig({ childThinking: "ultra" })).toThrow("childThinking");
  });

  it("keeps delegate_task in every enforced allowlist", () => {
    expect(parseConfig({}).allowedParentTools.coordinatorOnly).toContain("delegate_task");
    expect(parseConfig({ allowedParentTools: { delegateExecution: ["read"] } }).allowedParentTools.delegateExecution).toContain("delegate_task");
  });
});