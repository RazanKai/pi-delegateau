import { describe, expect, it, vi } from "vitest";
import { JevDelegationSelector } from "../src/gate.js";
import { JevSelector } from "../src/jev.js";
import type { CandidateProfile } from "../src/types.js";

const profiles: CandidateProfile[] = [
  { identity: { provider: "alpha", id: "fast-1" }, description: "fast", capabilities: ["code"], provenance: "user", cost: { input: 0.5, output: 1 }, latencyMs: 300, contextWindow: 128_000 },
  { identity: { provider: "beta", id: "strong-1" }, description: "strong", capabilities: ["code", "review"], provenance: "built-in" },
];

describe("JevSelector", () => {
  it("sends one bounded Choice over exact candidate IDs and maps the answer", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        selected_model: {
          choice: "beta/strong-1",
          confidence: 0.8,
          probabilities: { "alpha/fast-1": 0.2, "beta/strong-1": 0.8 },
        },
      },
      usage: { input_tokens: 20, output_tokens: 5 },
    });
    const selector = new JevSelector({ client: { systemOne }, timeoutMs: 1500 });
    const answer = await selector.choose({
      question: "Which model fits?",
      candidateIds: ["alpha/fast-1", "beta/strong-1"],
      state: {
        task: "TASK DATA",
        context: "CONTEXT DATA",
        preference: "balanced",
        agent: { name: "worker", instructions: "trusted", tools: ["read"] },
        candidates: profiles,
      },
    });
    expect(answer).toMatchObject({ identity: { provider: "beta", id: "strong-1" }, confidence: 0.8 });
    expect(systemOne).toHaveBeenCalledOnce();
    const request = systemOne.mock.calls[0]![0] as any;
    expect(request.model).toBe("jev-latest");
    // The criterion is the description PLUS the provider-published facts. Prose
    // alone is what let a model be chosen on an unverified capability claim
    // while its real price went unread, so the facts are part of the contract.
    expect(request.questions.selected_model.criteria["alpha/fast-1"]).toContain("fast");
    expect(request.questions.selected_model.criteria["beta/strong-1"]).toContain("strong");
    // A candidate whose price the provider did not declare is labelled unknown
    // rather than silently carrying a guess.
    expect(request.questions.selected_model.criteria["beta/strong-1"]).toContain("price unknown");
    expect(JSON.stringify(request)).toContain("TASK DATA");
  });

  it("passes live headroom to Jev instead of making quota a hidden preference", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: { selected_model: { choice: "beta/strong-1" } } });
    const selector = new JevSelector({
      client: { systemOne },
      timeoutMs: 100,
      quotaState: {
        alpha: {
          provider: "alpha",
          source: "snapshot",
          windows: [{ name: "weekly", usedFraction: 0.9, remainingFraction: 0.1 }],
        },
        beta: {
          provider: "beta",
          source: "snapshot",
          windows: [{ name: "weekly", usedFraction: 0.2, remainingFraction: 0.8 }],
        },
      },
    });
    await selector.choose({
      question: "Which model fits?",
      candidateIds: ["alpha/fast-1", "beta/strong-1"],
      state: { task: "t", preference: "balanced", agent: { name: "w", instructions: "i", tools: [] }, candidates: profiles },
    });
    const request = systemOne.mock.calls[0]![0] as any;
    expect(request.questions.selected_model.criteria["alpha/fast-1"]).toContain("alpha quota headroom: weekly 10% remaining");
    expect(request.questions.selected_model.criteria["beta/strong-1"]).toContain("beta quota headroom: weekly 80% remaining");
    expect(request.state.providerQuota.alpha.windows[0].remainingFraction).toBe(0.1);
  });

  // provenance) reaches the chooser so routing preferences are interpretable.
  it("forwards known candidate metadata to the chooser", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: { selected_model: { choice: "alpha/fast-1" } } });
    const selector = new JevSelector({ client: { systemOne }, timeoutMs: 100 });
    await selector.choose({
      question: "Which model fits?",
      candidateIds: ["alpha/fast-1", "beta/strong-1"],
      state: { task: "t", preference: "economy", agent: { name: "w", instructions: "i", tools: ["read"] }, candidates: profiles },
    });
    const sent = systemOne.mock.calls[0]![0].state.candidates as any[];
    const fast = sent.find((candidate) => candidate.id === "alpha/fast-1");
    expect(fast).toMatchObject({ provenance: "user", cost: { input: 0.5, output: 1 }, latencyMs: 300, contextWindow: 128_000 });
    const strong = sent.find((candidate) => candidate.id === "beta/strong-1");
    expect(strong.provenance).toBe("built-in");
    expect(strong.cost).toBeUndefined();
  });

  // F11 regression: probabilities outside the candidate set or [0,1] are
  // dropped rather than persisted.
  it("drops invalid and non-candidate probabilities", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        selected_model: {
          choice: "alpha/fast-1",
          probabilities: { "alpha/fast-1": 0.4, "NOT-A-CANDIDATE/evil": 99, "beta/strong-1": -5 },
        },
      },
    });
    const selector = new JevSelector({ client: { systemOne }, timeoutMs: 100 });
    const answer = await selector.choose({
      question: "q",
      candidateIds: ["alpha/fast-1", "beta/strong-1"],
      state: { task: "t", preference: "balanced", agent: { name: "w", instructions: "i", tools: [] }, candidates: profiles },
    });
    expect(answer.probabilities).toEqual({ "alpha/fast-1": 0.4, "beta/strong-1": -5 });
    expect(Object.keys(answer.probabilities ?? {})).not.toContain("NOT-A-CANDIDATE/evil");
  });

  it("drops non-finite confidence values", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: { selected_model: { choice: "alpha/fast-1", confidence: Number.NaN } } });
    const selector = new JevSelector({ client: { systemOne }, timeoutMs: 100 });
    const answer = await selector.choose({
      question: "q",
      candidateIds: ["alpha/fast-1", "beta/strong-1"],
      state: { task: "t", preference: "balanced", agent: { name: "w", instructions: "i", tools: [] }, candidates: profiles },
    });
    expect(answer.confidence).toBeUndefined();
  });

  it("sends a bounded local-versus-delegated Choice", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: { recommendation: { choice: "delegate", confidence: 0.7 } } });
    const selector = new JevDelegationSelector({ client: { systemOne }, timeoutMs: 100 });
    const answer = await selector.choose({
      question: "Which path?",
      state: {
        prompt: "implement TASK",
        parent: { provider: "parent", id: "model", capabilities: ["code"] },
        baseMode: "normal",
        baseTools: ["read", "write", "delegate_task"],
        preference: "balanced",
        candidates: [{ identity: { provider: "child", id: "model" }, description: "child", capabilities: ["code"], provenance: "user" }],
        childAvailable: true,
        childAgentNames: ["worker"],
      },
    });
    expect(answer).toEqual({ recommendation: "delegate", confidence: 0.7 });
    expect(systemOne.mock.calls[0]![0]).toMatchObject({ model: "jev-latest", questions: { recommendation: { criteria: { local: expect.any(String), delegate: expect.any(String) } } } });
  });

  // F01 regression: an unusable TypeSafe client is a choose() failure, not a
  // constructor throw. Hermetic: the env key is removed inside the test.
  it("does not throw at construction without credentials and fails cleanly in choose", async () => {
    const priorKey = process.env.TYPESAFE_API_KEY;
    const priorBase = process.env.TYPESAFE_BASE_URL;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_BASE_URL;
    try {
      expect(() => new JevSelector({ timeoutMs: 50 })).not.toThrow();
      const selector = new JevSelector({ timeoutMs: 50 });
      await expect(selector.choose({
        question: "q",
        candidateIds: ["alpha/fast-1"],
        state: { task: "t", preference: "balanced", agent: { name: "w", instructions: "i", tools: [] }, candidates: [profiles[0]!] },
      })).rejects.toThrow(/unavailable|credentials/i);
    } finally {
      if (priorKey !== undefined) process.env.TYPESAFE_API_KEY = priorKey;
      if (priorBase !== undefined) process.env.TYPESAFE_BASE_URL = priorBase;
    }
  });
});