import { describe, expect, it } from "vitest";
import { ModeController, policyForMode } from "../src/mode.js";

describe("delegation mode", () => {
  it("defines explicit allowlists for enforced modes", () => {
    expect(policyForMode("normal").enforced).toBe(false);
    expect(policyForMode("delegate-execution").allowedTools).toEqual(["delegate_task", "read", "search"]);
    expect(policyForMode("coordinator-only").allowedTools).toEqual(["delegate_task", "ask_user"]);
  });

  it("saves and restores tools and rejects changes while busy", () => {
    const calls: string[][] = [];
    const controller = new ModeController({
      getActiveTools: () => ["read", "write", "bash"],
      setActiveTools: (tools) => calls.push(tools),
    });
    expect(controller.activate("delegate-execution")).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["delegate_task", "read", "search"]);
    controller.setBusy(true);
    expect(controller.activate("coordinator-only")).toEqual({ ok: false, reason: "busy" });
    controller.setBusy(false);
    expect(controller.deactivate()).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["read", "write", "bash"]);
  });

  it("blocks unknown tools at the call boundary in enforced modes", () => {
    const controller = new ModeController({ getActiveTools: () => [], setActiveTools: () => undefined });
    controller.activate("coordinator-only");
    expect(controller.guard("bash")).toEqual({ block: true, reason: expect.stringContaining("coordinator-only") });
    expect(controller.guard("delegate_task")).toBeUndefined();
  });

  it("uses configured allowlists without admitting unknown tools", () => {
    const calls: string[][] = [];
    const controller = new ModeController({ getActiveTools: () => ["read"], setActiveTools: (tools) => calls.push(tools) });
    controller.setAllowedTools("delegate-execution", ["delegate_task", "custom_read"]);
    expect(controller.activate("delegate-execution")).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["delegate_task", "custom_read"]);
    expect(controller.guard("bash")?.block).toBe(true);
    expect(controller.guard("custom_read")).toBeUndefined();
  });
});
