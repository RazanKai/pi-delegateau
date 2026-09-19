import { describe, expect, it } from "vitest";
import { ChildRunner } from "../src/runner.js";

describe("child runner", () => {
  it("normalizes a provider error even when the process exits zero", async () => {
    const runner = new ChildRunner({
      spawn: async (_request, emit) => {
        emit({ type: "assistant", model: "alpha/fast", stopReason: "error", errorMessage: "provider down", text: "" });
        return { exitCode: 0, observedExit: true };
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
    const runner = new ChildRunner({ spawn: async () => ({ exitCode: 0, observedExit: true }) });
    await expect(
      runner.run({ model: { provider: "alpha", id: "fast" }, task: "x", cwd: "/tmp", tools: ["read"], signal: controller.signal }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });
});
