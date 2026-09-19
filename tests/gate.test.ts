import { describe, expect, it, vi } from "vitest";
import { DelegationGate, JevDelegationSelector, type DelegationGateInput } from "../src/gate.js";
import { ModeController } from "../src/mode.js";

const base: DelegationGateInput = {
  prompt: "Implement the feature",
  policy: "jev-enforce",
  baseMode: "normal",
  baseTools: ["read", "write", "bash", "delegate_task", "ask_user"],
  preference: "balanced",
  parent: { provider: "parent", id: "model", capabilities: ["code", "tools"] },
  candidates: [
    { identity: { provider: "child", id: "strong" }, description: "Strong child", capabilities: ["code"], provenance: "user" },
  ],
  childAvailable: true,
  childAgentNames: ["worker"],
  allowExternalSensing: true,
  deadlineMs: 100,
  maxGatePromptChars: 20_000,
};

const answer = { recommendation: "delegate" as const, confidence: 0.9 };

describe("request-scoped delegation gate", () => {
  it("waits for one Jev decision and applies a delegate restriction", async () => {
    const choose = vi.fn().mockResolvedValue(answer);
    const gate = new DelegationGate();
    const result = await gate.ensure(base, { choose });
    expect(result).toMatchObject({ policy: "jev-enforce", source: "jev", recommendation: "delegate", restriction: "delegate", status: "applied", generation: 1 });
    expect(choose).toHaveBeenCalledOnce();
    expect(gate.current()).toEqual(result);
  });

  it("does not ask Jev in manual mode and does not consume a child admission", async () => {
    const choose = vi.fn();
    const result = await new DelegationGate().ensure({ ...base, policy: "manual" }, { choose });
    expect(result).toMatchObject({ source: "manual", status: "manual", restriction: "none" });
    expect(choose).not.toHaveBeenCalled();
  });

  it("keeps advisory recommendations from changing the tool surface", async () => {
    const gate = new DelegationGate();
    const result = await gate.ensure({ ...base, policy: "jev-suggest" }, { choose: async () => answer });
    expect(result).toMatchObject({ recommendation: "delegate", restriction: "none" });
  });

  it("fails closed for enforcement when Jev fails", async () => {
    const choose = vi.fn().mockRejectedValue(new Error("sensor unavailable"));
    const result = await new DelegationGate().ensure(base, { choose });
    expect(result).toMatchObject({ source: "failed", status: "blocked", restriction: "blocked" });
  });

  it("returns visible manual fallback for advisory failures", async () => {
    const choose = vi.fn().mockRejectedValue(new Error("sensor unavailable"));
    const result = await new DelegationGate().ensure({ ...base, policy: "jev-suggest" }, { choose });
    expect(result).toMatchObject({ source: "fallback", status: "fallback", restriction: "none" });
  });

  it("cancels a pending decision without accepting a late answer", async () => {
    let resolveChoice!: (value: typeof answer) => void;
    const choose = vi.fn(() => new Promise<typeof answer>((resolve) => { resolveChoice = resolve; }));
    const gate = new DelegationGate();
    const pending = gate.ensure(base, { choose });
    gate.invalidate("steering");
    resolveChoice(answer);
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.recommendation).toBeUndefined();
    expect(result.restriction).toBe("blocked");
  });

  it("keeps one decision across repeated before-turn calls and starts a new generation after settlement", async () => {
    const choose = vi.fn().mockResolvedValue(answer);
    const gate = new DelegationGate();
    const first = await gate.ensure(base, { choose });
    const repeated = await gate.ensure(base, { choose });
    gate.markExecution("delegated");
    gate.settle();
    const second = await gate.ensure({ ...base, prompt: "A new request" }, { choose });
    expect(repeated.decisionId).toBe(first.decisionId);
    expect(second.generation).toBe(2);
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit override ahead of a late Jev answer", async () => {
    let resolveChoice!: (value: typeof answer) => void;
    const gate = new DelegationGate();
    const pending = gate.ensure(base, { choose: async () => new Promise<typeof answer>((resolve) => { resolveChoice = resolve; }) });
    const override = gate.override("local");
    resolveChoice(answer);
    expect(await pending).toMatchObject({ source: "user-override", override: "local", restriction: "none" });
  });

  it("never widens a base mode when applying gate restrictions", () => {
    const calls: string[][] = [];
    const mode = new ModeController({
      getActiveTools: () => ["read", "write", "bash", "delegate_task"],
      setActiveTools: (names) => calls.push(names),
    });
    mode.setRequestRestriction("delegate");
    expect(calls.at(-1)).toEqual(["read", "delegate_task"]);
    mode.setRequestRestriction("blocked");
    expect(calls.at(-1)).toEqual(["delegate_task"]);
    mode.clearRequestRestriction();
    expect(calls.at(-1)).toEqual(["read", "write", "bash", "delegate_task"]);
  });

  // F02 regression: cancelling a fast-path decision must not create an
  // orphaned rejected promise that kills the host process.
  it("invalidating or overriding a manual (fast-path) decision leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      for (const action of ["invalidate", "override", "invalidate-enforced"] as const) {
        const gate = new DelegationGate();
        const input = action === "invalidate-enforced" ? { ...base, allowExternalSensing: false } : { ...base, policy: "manual" as const };
        await gate.ensure(input);
        if (action === "override") gate.override("manual");
        else gate.invalidate("material user steering");
        // Let the microtask queue drain so any orphaned rejection surfaces.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  // F09 regression: an enforced base mode resolves policy-determined
  // delegation even when external sensing is prohibited.
  it("resolves policy-determined delegation before the disclosure check", async () => {
    const choose = vi.fn();
    const gate = new DelegationGate();
    const result = await gate.ensure({ ...base, baseMode: "delegate-execution", allowExternalSensing: false }, { choose });
    expect(result).toMatchObject({ source: "policy-determined", recommendation: "delegate", restriction: "delegate", status: "applied" });
    expect(choose).not.toHaveBeenCalled();
  });

  // F02-adjacent regression: a changed policy for the same prompt must not
  // silently reuse the old decision.
  it("does not reuse a decision across changed policies with identical prompts", async () => {
    const choose = vi.fn().mockResolvedValue(answer);
    const gate = new DelegationGate();
    const first = await gate.ensure({ ...base, policy: "jev-suggest" }, { choose });
    const second = await gate.ensure({ ...base, policy: "jev-enforce" }, { choose });
    expect(second.decisionId).not.toBe(first.decisionId);
    expect(second.policy).toBe("jev-enforce");
  });

  // F01 regression: a sensor whose constructor fails must yield a normal
  // choose() failure (fail-closed), not a constructor throw. Hermetic env.
  it("treats an unusable TypeSafe client as a sensor failure inside the gate", async () => {
    const priorKey = process.env.TYPESAFE_API_KEY;
    const priorBase = process.env.TYPESAFE_BASE_URL;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_BASE_URL;
    try {
      const selector = new JevDelegationSelector({ timeoutMs: 50 });
      // No injected client and no TYPESAFE_API_KEY: the constructor must not throw.
      expect(() => new JevDelegationSelector({ timeoutMs: 50 })).not.toThrow();
      await expect(selector.choose({ question: "q", state: { prompt: "p", parent: { capabilities: [] }, baseMode: "normal", baseTools: [], preference: "balanced", candidates: [], childAvailable: false, childAgentNames: [] } }))
        .rejects.toThrow(/unavailable|credentials/i);
      const gate = new DelegationGate();
      const decision = await gate.ensure(base, selector);
      expect(decision).toMatchObject({ status: "blocked", source: "failed", restriction: "blocked" });
    } finally {
      if (priorKey !== undefined) process.env.TYPESAFE_API_KEY = priorKey;
      if (priorBase !== undefined) process.env.TYPESAFE_BASE_URL = priorBase;
    }
  });
});