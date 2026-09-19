import { describe, expect, it, vi } from "vitest";
import { JevSelector } from "../src/jev.js";


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
        candidates: [
          { identity: { provider: "alpha", id: "fast-1" }, description: "fast", capabilities: ["code"], provenance: "user" },
          { identity: { provider: "beta", id: "strong-1" }, description: "strong", capabilities: ["review"], provenance: "built-in" },
        ],
      },
    });
    expect(answer).toMatchObject({ identity: { provider: "beta", id: "strong-1" }, confidence: 0.8 });
    expect(systemOne).toHaveBeenCalledOnce();
    const request = systemOne.mock.calls[0]![0] as any;
    expect(request.model).toBe("jev-latest");
    expect(request.questions.selected_model.criteria).toEqual({ "alpha/fast-1": "fast", "beta/strong-1": "strong" });
    expect(JSON.stringify(request)).toContain("TASK DATA");
  });
});
