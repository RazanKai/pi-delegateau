import { describe, expect, it } from "vitest";
import {
  MAX_COOLDOWN_MULTIPLIER,
  TRIAL_MAX_AGE_MS,
  abandonTrial,
  beginTrial,
  classifyChildError,
  classifyChildHealth,
  emptyHealthState,
  getCircuitState,
  isHealthFailure,
  recordHealthFailure,
  recordHealthSuccess,
  resolveHealthConfig,
  type HealthCategory,
  type HealthState,
} from "../src/health.js";

const CONFIG = { failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
const MIN = 60_000;

function failures(state: HealthState, key: string, now: number, count: number, category: HealthCategory = "quota"): HealthState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = recordHealthFailure(next, key, CONFIG, now + i * MIN, category);
  return next;
}

describe("runtime health circuit transitions", () => {
  it("applies the bounded product defaults", () => {
    expect(resolveHealthConfig()).toMatchObject({ enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 });
  });

  it("opens at the threshold within the window and sets a cooldown", () => {
    const now = 1_000_000;
    const state = failures(emptyHealthState(), "alpha/one", now, 3);
    const circuit = getCircuitState(state, "alpha/one", now + 2, CONFIG);
    expect(circuit.open).toBe(true);
    expect(circuit.openUntil).toBe(now + 2 * MIN + 60 * MIN);
  });

  it("does not open below the threshold", () => {
    const now = 1_000_000;
    const state = failures(emptyHealthState(), "alpha/one", now, 2);
    expect(getCircuitState(state, "alpha/one", now + 1, CONFIG).open).toBe(false);
  });

  it("prunes failures outside the rolling window", () => {
    let state = emptyHealthState();
    state = recordHealthFailure(state, "alpha/one", CONFIG, 0, "quota");
    state = recordHealthFailure(state, "alpha/one", CONFIG, 6 * MIN, "quota");
    state = recordHealthFailure(state, "alpha/one", CONFIG, 7 * MIN, "quota");
    // The first failure is older than 5 minutes relative to 7 minutes.
    expect(getCircuitState(state, "alpha/one", 7 * MIN, CONFIG).recentFailures).toBe(2);
    expect(getCircuitState(state, "alpha/one", 7 * MIN, CONFIG).open).toBe(false);
  });

  it("moves to half-open after the cooldown and allows exactly one trial", () => {
    const now = 1_000_000;
    const opened = failures(emptyHealthState(), "alpha/one", now, 3);
    const openUntil = getCircuitState(opened, "alpha/one", now, CONFIG).openUntil!;
    const after = getCircuitState(opened, "alpha/one", openUntil + 1, CONFIG);
    expect(after.open).toBe(false);
    expect(after.halfOpen).toBe(true);

    const trialing = beginTrial(opened, "alpha/one", openUntil + 1);
    const trialState = getCircuitState(trialing, "alpha/one", openUntil + 1, CONFIG);
    expect(trialState.trialActive).toBe(true);
    expect(trialState.halfOpen).toBe(false);
    expect(trialState.trialClaimedAt).toBe(openUntil + 1);

    // A second claim while the first is live must not start another trial.
    expect(beginTrial(trialing, "alpha/one", openUntil + 2)).toBe(trialing);
  });

  it("closes the circuit on a successful trial", () => {
    const now = 1_000_000;
    const opened = failures(emptyHealthState(), "alpha/one", now, 3);
    const openUntil = getCircuitState(opened, "alpha/one", now, CONFIG).openUntil!;
    const trialing = beginTrial(opened, "alpha/one", openUntil + 1);
    const closed = recordHealthSuccess(trialing, "alpha/one", openUntil + 1);
    const circuit = getCircuitState(closed, "alpha/one", openUntil + 1, CONFIG);
    expect(circuit.open).toBe(false);
    expect(circuit.halfOpen).toBe(false);
    expect(circuit.trialActive).toBe(false);
    expect(circuit.recentFailures).toBe(0);
    expect(closed.models["alpha/one"]!.cooldownMultiplier).toBeUndefined();
    expect(closed.models["alpha/one"]!.trialClaimedAt).toBeUndefined();
  });

  it("reopens a failed trial with bounded exponential backoff", () => {
    const now = 1_000_000;
    let state = failures(emptyHealthState(), "alpha/one", now, 3);
    let openUntil = getCircuitState(state, "alpha/one", now, CONFIG).openUntil!;
    const expectedMultipliers = [2, 4, 8, 16, 16];

    for (const multiplier of expectedMultipliers) {
      const trialAt = openUntil + 1;
      state = beginTrial(state, "alpha/one", trialAt);
      state = recordHealthFailure(state, "alpha/one", CONFIG, trialAt, "quota");
      const circuit = getCircuitState(state, "alpha/one", trialAt, CONFIG);
      expect(circuit.open).toBe(true);
      expect(circuit.openUntil).toBe(trialAt + 60 * MIN * multiplier);
      expect(state.models["alpha/one"]!.cooldownMultiplier).toBe(Math.min(multiplier, MAX_COOLDOWN_MULTIPLIER));
      openUntil = circuit.openUntil!;
    }
  });

  it("releases a trial without counting cancellation as success or failure", () => {
    const now = 1_000_000;
    const opened = failures(emptyHealthState(), "alpha/one", now, 3);
    const openUntil = getCircuitState(opened, "alpha/one", now, CONFIG).openUntil!;
    const trialing = beginTrial(opened, "alpha/one", openUntil + 1);
    const released = abandonTrial(trialing, "alpha/one");
    const circuit = getCircuitState(released, "alpha/one", openUntil + 1, CONFIG);
    expect(circuit.trialActive).toBe(false);
    expect(circuit.halfOpen).toBe(true);
    expect(circuit.open).toBe(false);
  });

  it("expires a trial claim so a killed process cannot strand a model", () => {
    const now = 1_000_000;
    const opened = failures(emptyHealthState(), "alpha/one", now, 3);
    const openUntil = getCircuitState(opened, "alpha/one", now, CONFIG).openUntil!;
    const claimedAt = openUntil + 1;
    const trialing = beginTrial(opened, "alpha/one", claimedAt);

    // Within the claim age the model is owned by that trial.
    const during = getCircuitState(trialing, "alpha/one", claimedAt + TRIAL_MAX_AGE_MS - 1, CONFIG);
    expect(during.trialActive).toBe(true);
    expect(during.halfOpen).toBe(false);

    // Past it the claim no longer counts and the model is claimable again.
    const stale = getCircuitState(trialing, "alpha/one", claimedAt + TRIAL_MAX_AGE_MS, CONFIG);
    expect(stale.trialActive).toBe(false);
    expect(stale.halfOpen).toBe(true);
    expect(stale.open).toBe(false);
    expect(beginTrial(trialing, "alpha/one", claimedAt + TRIAL_MAX_AGE_MS)).not.toBe(trialing);
  });

  it("treats a claim with no stamp as expired rather than trusting it", () => {
    const now = 1_000_000;
    const opened = failures(emptyHealthState(), "alpha/one", now, 3);
    const openUntil = getCircuitState(opened, "alpha/one", now, CONFIG).openUntil!;
    // A state file written before claims carried a timestamp.
    const legacy: HealthState = {
      version: 1,
      models: { "alpha/one": { ...opened.models["alpha/one"]!, trialActive: true } },
    };
    const circuit = getCircuitState(legacy, "alpha/one", openUntil + 1, CONFIG);
    expect(circuit.trialActive).toBe(false);
    expect(circuit.halfOpen).toBe(true);
  });

  it("ignores categories that are not model-serving failures", () => {
    const state = emptyHealthState();
    for (const category of ["launch", "cancellation", "task-failure", "cleanup", "unknown"] as HealthCategory[]) {
      expect(isHealthFailure(category)).toBe(false);
      expect(recordHealthFailure(state, "alpha/one", CONFIG, 0, category)).toBe(state);
    }
    for (const category of ["unsupported-model", "auth", "quota", "timeout", "network", "provider-stream"] as HealthCategory[]) {
      expect(isHealthFailure(category)).toBe(true);
    }
  });
});

describe("child outcome classification", () => {
  it("classifies raw provider bodies into stable categories", () => {
    expect(classifyChildError("The 'x' model is not supported when using Codex with a ChatGPT account")).toBe("unsupported-model");
    expect(classifyChildError("401 Unauthorized: invalid api key")).toBe("auth");
    expect(classifyChildError("429 rate limit exceeded")).toBe("quota");
    expect(classifyChildError("Request timed out after 200ms")).toBe("timeout");
    expect(classifyChildError("fetch failed: ENOTFOUND api.example")).toBe("network");
    expect(classifyChildError("Child stopped early: stopReason length")).toBe("task-failure");
    expect(classifyChildError("Child produced no assistant completion")).toBe("provider-stream");
    expect(classifyChildError("brand new body with an echoed prompt")).toBe("unknown");
    // An empty body is not evidence of a provider fault: a child that answered
    // and then exited non-zero must not open its model's circuit.
    expect(classifyChildError("")).toBe("unknown");
    expect(classifyChildError("   ")).toBe("unknown");
  });

  it("counts only provider/serving failures for a started child", () => {
    expect(classifyChildHealth({ status: "success", processStarted: true, observedExit: true, groupCleaned: true })).toEqual({ kind: "success" });
    expect(classifyChildHealth({ status: "failed", error: "429 rate limit exceeded", processStarted: true, observedExit: true })).toEqual({ kind: "failure", category: "quota" });
    expect(classifyChildHealth({ status: "timed-out", processStarted: true, observedExit: false })).toEqual({ kind: "none", category: "task-failure" });
    expect(classifyChildHealth({ status: "failed", error: "brand new body", processStarted: true })).toEqual({ kind: "none", category: "unknown" });
    // A non-zero exit after a completed answer reports `failed` with no error
    // text. It must not count against the model: the work was produced.
    expect(classifyChildHealth({ status: "failed", processStarted: true, observedExit: true })).toEqual({ kind: "none", category: "unknown" });
  });

  it("never blames the model for cancellation, task limits, launch or cleanup", () => {
    expect(classifyChildHealth({ status: "cancelled", processStarted: true })).toEqual({ kind: "none", category: "cancellation" });
    expect(classifyChildHealth({ status: "limit-exceeded", processStarted: true })).toEqual({ kind: "none", category: "task-failure" });
    expect(classifyChildHealth({ status: "launch-error", processStarted: false })).toEqual({ kind: "none", category: "launch" });
    expect(classifyChildHealth({ status: "failed", error: "429 rate limit exceeded", processStarted: false })).toEqual({ kind: "none", category: "launch" });
    expect(classifyChildHealth({ status: "success", processStarted: true, observedExit: true, groupCleaned: false })).toEqual({ kind: "none", category: "cleanup" });
  });
});
