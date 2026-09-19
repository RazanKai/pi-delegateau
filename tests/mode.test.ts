import { describe, expect, it } from "vitest";
import { ModeController, policyForMode } from "../src/mode.js";

describe("delegation mode", () => {
  it("defines explicit allowlists for enforced modes", () => {
    expect(policyForMode("normal").enforced).toBe(false);
    expect(policyForMode("delegate-execution").allowedTools).toEqual(["delegate_task", "read", "grep", "find", "ls"]);
    expect(policyForMode("coordinator-only").allowedTools).toEqual(["delegate_task"]);
  });

  it("saves and restores tools and rejects changes while busy", () => {
    const calls: string[][] = [];
    const controller = new ModeController({
      getActiveTools: () => ["read", "write", "bash"],
      setActiveTools: (tools) => calls.push(tools),
    });
    expect(controller.activate("delegate-execution")).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["delegate_task", "read", "grep", "find", "ls"]);
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

  // F06 regression: clearing a request restriction while an enforced mode is
  // active must re-apply the enforced allowlist, not restore raw pre-
  // restriction tools that include bash/edit/write.
  it("clearing a request restriction never re-advertises tools forbidden by the active mode", () => {
    const calls: string[][] = [];
    // The mode activation already narrowed the ACTIVE surface; the stub
    // reflects what getActiveTools() returns after activation.
    let active = ["delegate_task", "read", "grep", "write"];
    const controller = new ModeController({
      getActiveTools: () => active,
      setActiveTools: (names) => { active = [...names]; calls.push(names); },
    });
    controller.setAllowedTools("delegate-execution", ["delegate_task", "read", "grep"]);
    expect(controller.activate("delegate-execution")).toEqual({ ok: true });
    controller.setRequestRestriction("delegate");
    expect(calls.at(-1)).toEqual(["delegate_task", "read", "grep"]);
    controller.clearRequestRestriction();
    const restored = calls.at(-1)!;
    expect(restored).toEqual(["delegate_task", "read", "grep"]);
    expect(restored).not.toContain("write");
    expect(restored).not.toContain("bash");
    expect(controller.guard("bash")?.block).toBe(true);
  });

  // F06 regression: activating a mode while a request restriction is active
  // must save the true normal surface, not the restricted snapshot, so
  // deactivate() restores the user's real tools.
  it("deactivating after a restriction restores the true normal-mode surface", () => {
    const available = ["read", "write", "bash", "delegate_task"];
    let active = [...available];
    const controller = new ModeController({
      getActiveTools: () => active,
      setActiveTools: (names) => { active = names; },
      getAllTools: () => available.map((name) => ({ name })),
    });
    controller.setRequestRestriction("delegate");
    expect(active).toEqual(["read", "delegate_task"]);
    expect(controller.activate("delegate-execution")).toEqual({ ok: true });
    controller.clearRequestRestriction();
    expect(controller.deactivate()).toEqual({ ok: true });
    expect(active).toEqual(available);
  });
});