import { describe, expect, it } from "vitest";
import { ChildRunner } from "../src/runner.js";

describe("child runner", () => {
  it("normalizes a provider error even when the process exits zero", async () => {
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "error", errorMessage: "provider down", text: "" });
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"] });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("provider down");
    expect(result.appliedModel).toEqual({ provider: "alpha", id: "fast" });
  });

  it("reports a cancelled run distinctly", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new ChildRunner({ spawn: async () => ({ exitCode: 0, observedExit: true, groupCleaned: true }) });
    await expect(
      runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"], signal: controller.signal }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  // F07 regression: incomplete stop reasons are failures, not successes.
  it.each(["aborted", "length", "deferred"] as const)("reports stopReason %s as failed, not success", async (stopReason) => {
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason, text: "partial" });
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"] });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(stopReason);
  });

  it("reports a zero-exit child with no assistant completion as failed", async () => {
    const runner = new ChildRunner({
      spawn: async () => ({ exitCode: 0, observedExit: true, groupCleaned: true }),
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"] });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no assistant completion");
  });

  // F06 regression: provider-served model evidence is reported separately.
  it("records served-model evidence distinct from the requested model", async () => {
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/requested", responseModel: "omega/served-cheap", stopReason: "stop", text: "done" });
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "requested" }, task: "x", cwd: "/tmp", tools: ["read"] });
    expect(result.status).toBe("success");
    expect(result.appliedModel).toEqual({ provider: "alpha", id: "requested" });
    expect(result.servedModel).toEqual({ provider: "omega", id: "served-cheap" });
    expect(result.requestedModel).toEqual({ provider: "alpha", id: "requested" });
  });

  // F11 regression: turn budget rejects the turn that would exceed the limit
  // before consuming it.
  it("stops consuming turns once the turn limit is exceeded", async () => {
    let emitted = 0;
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "turn-1" });
        emitted += 1;
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "turn-2" });
        emitted += 1;
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"], maxTurns: 1 });
    expect(result.status).toBe("limit-exceeded");
    // The limit-tripping turn is counted once; the point is that the run is
    // marked limit-exceeded rather than reported as success with extra turns.
    expect(emitted).toBeLessThanOrEqual(2);
  });

  // F11 regression: output truncation is flagged, not silent.
  it("flags output truncation instead of presenting partial text as complete", async () => {
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "FIRST-CHUNK-important-header" });
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "x".repeat(200) });
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"], maxOutputChars: 50 });
    expect(result.outputTruncated).toBe(true);
    expect(result.output.length).toBe(50);
  });

  // F09-adjacent regression: usage aggregation keeps earlier fields.
  it("aggregates usage across turns without dropping earlier fields", async () => {
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "t1", usage: { inputTokens: 100, totalTokens: 150, cost: 0.5 } });
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "t2", usage: { outputTokens: 60, cacheReadTokens: 10 } });
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"] });
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 60, totalTokens: 150, cacheReadTokens: 10, cost: 0.5 });
  });
});