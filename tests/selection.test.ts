import { describe, expect, it, vi } from "vitest";
import { selectModel } from "../src/selection.js";
import type { CandidateProfile, DelegateRequest, ModelIdentity } from "../src/types.js";

const alpha: ModelIdentity = { provider: "alpha", id: "fast-1" };
const beta: ModelIdentity = { provider: "beta", id: "strong-1" };
const profiles: CandidateProfile[] = [
  { identity: alpha, description: "Fast implementation model", capabilities: ["code"], provenance: "user" },
  { identity: beta, description: "Strong reasoning model", capabilities: ["code", "review"], provenance: "built-in" },
];
const base: DelegateRequest = {
  agent: { name: "worker", instructions: "Work carefully", tools: ["read"] },
  task: "Inspect the fixture",
  preference: "balanced",
  candidates: profiles,
  defaultModel: beta,
  selectionMode: "jev",
  allowExternalSensing: true,
};

describe("selectModel", () => {
  it("uses an eligible trusted pin without sensing", async () => {
    const choose = vi.fn();
    const result = await selectModel({ ...base, agent: { ...base.agent, model: alpha } }, { choose });
    expect(result).toMatchObject({ source: "pin", identity: alpha });
    expect(choose).not.toHaveBeenCalled();
  });

  it("uses the fixed eligible default without sensing", async () => {
    const choose = vi.fn();
    const result = await selectModel({ ...base, selectionMode: "fixed" }, { choose });
    expect(result).toMatchObject({ source: "fixed", identity: beta });
    expect(choose).not.toHaveBeenCalled();
  });

  it("uses a single Jev candidate without sensing", async () => {
    const choose = vi.fn();
    const result = await selectModel({ ...base, candidates: [profiles[0]!], defaultModel: undefined }, { choose });
    expect(result).toMatchObject({ source: "single-candidate", identity: alpha });
    expect(choose).not.toHaveBeenCalled();
  });

  it("uses the eligible default as an explicit fallback when Jev fails", async () => {
    const choose = vi.fn().mockRejectedValue(new Error("sensor unavailable"));
    const result = await selectModel(base, { choose });
    expect(result).toMatchObject({ source: "fallback", identity: beta });
    expect(result.cause).toContain("sensor unavailable");
  });

  it("rejects an empty eligible set before sensing or launch", async () => {
    const choose = vi.fn();
    await expect(selectModel({ ...base, candidates: [], defaultModel: undefined }, { choose })).rejects.toThrow(
      "No eligible models",
    );
    expect(choose).not.toHaveBeenCalled();
  });

  it("falls back to the eligible default for an invalid Jev selection", async () => {
    const choose = vi.fn().mockResolvedValue({ identity: { provider: "other", id: "nope" }, confidence: 0.2 });
    await expect(selectModel(base, { choose })).resolves.toMatchObject({ source: "fallback", identity: beta });
  });

  it("uses the eligible default when the Jev deadline expires", async () => {
    const choose = vi.fn(() => new Promise<never>(() => undefined));
    const result = await selectModel({ ...base, selectionDeadlineMs: 5 }, { choose });
    expect(result).toMatchObject({ source: "fallback", identity: beta });
    expect(result.cause).toContain("deadline");
  });

  it("does not fallback when sensing is cancelled", async () => {
    const choose = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const controller = new AbortController();
    controller.abort();
    await expect(selectModel(base, { choose, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
