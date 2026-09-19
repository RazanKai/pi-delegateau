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

  // F11 regression: turn budget refuses a turn the child wants to CONTINUE
  // into, so runaway work is still stopped at the budget edge.
  // NOTE: this test previously asserted the opposite for a terminal turn — it
  // used stopReason "stop" (a finished turn) and expected "limit-exceeded",
  // which encoded the bug this suite now pins as fixed. A terminal turn must
  // settle normally; only a continuation signal justifies aborting.
  it("stops runaway work at the turn budget when the child asks to continue", async () => {
    let aborted = false;
    const runner = new ChildRunner({
      spawn: async (request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "toolUse", text: "turn-1 wants to continue" });
        aborted = request.signal?.aborted === true;
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"], maxTurns: 1 });
    expect(result.status).toBe("limit-exceeded");
    expect(aborted).toBe(true);
  });

  // The bug this pins: a child that already produced its FINAL answer on the
  // last allowed turn must not be killed and relabelled "limit-exceeded" —
  // that discards completed output (observed live: a worker burned 13,564
  // output tokens and was reported as limit-exceeded).
  // The live bug this pins: a worker child burned 13,564 output tokens and was
  // reported "limit-exceeded" with its work discarded. This guards the
  // observable contract — a child that completes within its budget succeeds and
  // its output survives. (Passes on the base revision too; the red-on-base
  // proof for the abort timing is the test above.)
  it("keeps the output of a child that completed within its turn budget", async () => {
    let aborted = false;
    const runner = new ChildRunner({
      spawn: async (request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "toolUse", text: "working" });
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "FINAL-ANSWER" });
        aborted = request.signal?.aborted === true;
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"], maxTurns: 5 });
    expect(aborted).toBe(false);
    expect(result.status).toBe("success");
    expect(result.output).toContain("FINAL-ANSWER");
  });

  // A single terminal turn under a budget of one is complete work, not a
  // budget breach — the limit is an allowance, not a requirement to exceed it.
  it("treats a single terminal turn as success at a budget of one", async () => {
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "stop", text: "ONLY-TURN" });
        return { exitCode: 0, observedExit: true, groupCleaned: true };
      },
    });
    const result = await runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"], maxTurns: 1 });
    expect(result.status).toBe("success");
    expect(result.output).toContain("ONLY-TURN");
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