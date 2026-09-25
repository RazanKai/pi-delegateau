import { describe, expect, it } from "vitest";
import { resolveEligibleCandidates } from "../src/eligibility.js";
import { HealthStore, type HealthIo } from "../src/health-store.js";
import { emptyHealthState, type HealthState } from "../src/health.js";
import { selectModel } from "../src/selection.js";
import type { DelegateConfig, DelegateRequest, TrustedAgent } from "../src/types.js";

const NOW = 1_000_000;

function memoryHealth(opts: { open?: string[]; failureThreshold?: number } = {}): HealthStore {
  let stored: HealthState = emptyHealthState();
  const io: HealthIo = { load: () => structuredClone(stored), save: (_p, state) => { stored = structuredClone(state); } };
  const store = new HealthStore({ io, config: { failureThreshold: opts.failureThreshold ?? 1, windowMinutes: 5, cooldownMinutes: 60 }, now: () => NOW });
  for (const key of opts.open ?? []) {
    store.recordFailure(key, "quota", NOW);
    store.abandonTrial(key); // keep it open, not half-open
  }
  return store;
}

const CTX = {
  modelRegistry: {
    find: (provider: string, id: string) => ({ provider, id }),
    hasConfiguredAuth: () => true,
  },
} as any;

function config(candidates: DelegateConfig["candidates"]): DelegateConfig {
  return {
    selection: "jev",
    delegationDecision: "manual",
    mode: "normal",
    preference: "balanced",
    candidates,
    agentPins: {},
    agents: {},
    allowExternalSensing: true,
    allowedParentTools: { delegateExecution: [], coordinatorOnly: [] },
    limits: {} as any,
  };
}

const AGENT: TrustedAgent = { name: "worker", instructions: "work", tools: ["read"] };

describe("candidate eligibility integrates health before Jev", () => {
  it("excludes an open circuit and reports the cause", () => {
    const cfg = config([
      { identity: { provider: "alpha", id: "healthy" }, description: "", capabilities: [], provenance: "user" },
      { identity: { provider: "beta", id: "open" }, description: "", capabilities: [], provenance: "user" },
    ]);
    const health = memoryHealth({ open: ["beta/open"] });
    const result = resolveEligibleCandidates({ config: cfg, agent: AGENT, ctx: CTX, health, now: NOW });
    expect(result.candidates.map((candidate) => `${candidate.identity.provider}/${candidate.identity.id}`)).toEqual(["alpha/healthy"]);
    expect(result.excluded).toEqual([
      expect.objectContaining({ id: "beta/open", reasons: ["circuit-open"] }),
    ]);
    expect(result.excluded[0]!.openUntil).toBeDefined();
  });

  it("excludes a half-open candidate whose trial is already in flight", () => {
    const cfg = config([{ identity: { provider: "beta", id: "trial" }, description: "", capabilities: [], provenance: "user" }]);
    const health = memoryHealth({ open: ["beta/trial"] });
    // Move past the cooldown, then let another dispatch claim the trial.
    const store = health;
    const openUntil = store.circuit("beta/trial", NOW).openUntil!;
    expect(store.tryClaimTrial("beta/trial", openUntil + 1)).toEqual({ allowed: true, claimed: true });
    const result = resolveEligibleCandidates({ config: cfg, agent: AGENT, ctx: CTX, health: store, now: openUntil + 1 });
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded[0]!.reasons).toContain("trial-active");
  });

  it("keeps existing quota and reachability filters and reports stable reasons", () => {
    const cfg = config([
      { identity: { provider: "alpha", id: "good" }, description: "", capabilities: [], provenance: "user" },
      { identity: { provider: "beta", id: "dry" }, description: "", capabilities: [], provenance: "user" },
      { identity: { provider: "gamma", id: "gone" }, description: "", capabilities: [], provenance: "user" },
    ]);
    const quotaState = {
      beta: { provider: "beta", windows: [{ name: "weekly", usedFraction: 1, remainingFraction: 0 }], source: "snapshot" as const },
    };
    const result = resolveEligibleCandidates({
      config: cfg,
      agent: AGENT,
      ctx: CTX,
      quotaState,
      isUnreachable: (identity) => identity.provider === "gamma",
      now: NOW,
    });
    expect(result.candidates.map((candidate) => candidate.identity.id)).toEqual(["good"]);
    expect(result.excluded.find((entry) => entry.id === "beta/dry")!.reasons).toContain("quota-exhausted");
    expect(result.excluded.find((entry) => entry.id === "gamma/gone")!.reasons).toContain("unreachable");
  });

  it("never asks the chooser when the only candidate is an open circuit", async () => {
    const cfg = config([{ identity: { provider: "beta", id: "open" }, description: "", capabilities: [], provenance: "user" }]);
    const health = memoryHealth({ open: ["beta/open"] });
    const eligible = resolveEligibleCandidates({ config: cfg, agent: AGENT, ctx: CTX, health, now: NOW });
    const request: DelegateRequest = {
      agent: AGENT,
      task: "do work",
      preference: "balanced",
      candidates: eligible.candidates,
      selectionMode: "jev",
      allowExternalSensing: true,
    };
    let chooserCalled = false;
    await expect(selectModel(request, {
      choose: async () => {
        chooserCalled = true;
        return { identity: { provider: "beta", id: "open" } };
      },
    })).rejects.toThrow("No eligible models");
    expect(chooserCalled).toBe(false);
  });

  it("treats a disabled health store as fully transparent", () => {
    const cfg = config([
      { identity: { provider: "alpha", id: "healthy" }, description: "", capabilities: [], provenance: "user" },
      { identity: { provider: "beta", id: "stale-open" }, description: "", capabilities: [], provenance: "user" },
    ]);
    const store = new HealthStore({
      config: { enabled: false, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 },
      initialState: { version: 1, models: { "beta/stale-open": { failures: [NOW], openUntil: NOW + 60_000 } } },
      now: () => NOW,
    });
    const result = resolveEligibleCandidates({ config: cfg, agent: AGENT, ctx: CTX, health: store, now: NOW });
    expect(result.candidates.map((candidate) => candidate.identity.id)).toEqual(["healthy", "stale-open"]);
    expect(result.excluded).toHaveLength(0);
  });
});
