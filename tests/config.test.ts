import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_FILE_NAME, parseConfig, resolveConfig } from "../src/config.js";

describe("configuration", () => {
  it("rejects duplicate candidate identities and non-finite limits", () => {
    expect(() => parseConfig({ candidates: [{ provider: "a", id: "x" }, { provider: "a", id: "x" }] })).toThrow(
      "Duplicate candidate",
    );
    expect(() => parseConfig({ limits: { selectionDeadlineMs: 0 } })).toThrow("selectionDeadlineMs");
  });

  it("defaults to safe normal fixed behavior and bounded limits", () => {
    expect(parseConfig({})).toMatchObject({ selection: "fixed", delegationDecision: "manual", mode: "normal", preference: "balanced" });
    expect(parseConfig({}).limits.childOutputChars).toBeGreaterThan(0);
    expect(parseConfig({}).limits.maxGatePromptChars).toBeGreaterThan(0);
    expect(parseConfig({}).limits.maxExpectedOutputChars).toBeGreaterThan(0);
    expect(parseConfig({}).limits).toMatchObject({ concurrency: 3, maxQueueDepth: 20 });
  });

  it("validates the request gate policy and preserves model profile metadata", () => {
    expect(() => parseConfig({ delegationDecision: "unknown" })).toThrow("delegationDecision");
    expect(parseConfig({ delegationDecision: "jev-enforce", candidates: [{ provider: "a", id: "x", contextWindow: 1000, latencyMs: 20, cost: { input: 1, output: 2 } }] })).toMatchObject({
      delegationDecision: "jev-enforce",
      candidates: [{ contextWindow: 1000, latencyMs: 20, cost: { input: 1, output: 2 } }],
    });
  });

  it("rejects mutation tools re-admitted through configured parent allowlists", () => {
    // F06/F07 class: a user allowlist may not re-admit bash/write into an
    // enforced mode whose purpose is to withhold direct execution.
    const widened = parseConfig({ allowedParentTools: { delegateExecution: ["delegate_task", "bash", "write"] } });
    expect(widened.allowedParentTools.delegateExecution).not.toContain("bash");
    expect(widened.allowedParentTools.delegateExecution).not.toContain("write");
    expect(widened.allowedParentTools.delegateExecution).toContain("delegate_task");
  });

  it("rejects child agents with unapproved tools", () => {
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["bash", "shell"] } } })).toThrow("not approved child tools");
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["read", "delegate_task"] } } })).toThrow("delegate_task");
  });

  it("accepts extension tools only with an explicit per-agent extension allowlist", () => {
    expect(parseConfig({ agents: { worker: { instructions: "i", tools: ["read", "lens_diagnostics"], childExtensions: ["pi-lens"] } } }).agents.worker).toMatchObject({
      tools: ["read", "lens_diagnostics"],
      childExtensions: ["pi-lens"],
    });
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["lens_diagnostics"] } } })).toThrow("not approved child tools");
    expect(() => parseConfig({ agents: { worker: { instructions: "i", tools: ["read"], childExtensions: "pi-lens" } } })).toThrow("childExtensions must be an array");
  });

  it("validates pool limits", () => {
    expect(parseConfig({ limits: { concurrency: 2, maxQueueDepth: 0 } }).limits).toMatchObject({ concurrency: 2, maxQueueDepth: 0 });
    expect(() => parseConfig({ limits: { concurrency: 0 } })).toThrow("concurrency");
    expect(() => parseConfig({ limits: { maxQueueDepth: -1 } })).toThrow("maxQueueDepth");
  });

  it("accepts an explicit child thinking level and rejects invalid ones", () => {
    expect(parseConfig({ childThinking: "low" }).childThinking).toBe("low");
    expect(() => parseConfig({ childThinking: "ultra" })).toThrow("childThinking");
  });

  it("keeps delegate_task in every enforced allowlist", () => {
    expect(parseConfig({}).allowedParentTools.coordinatorOnly).toContain("delegate_task");
    expect(parseConfig({ allowedParentTools: { delegateExecution: ["read"] } }).allowedParentTools.delegateExecution).toContain("delegate_task");
  });
});

describe("config resolution: global agent-dir config unless a project config exists", () => {
  function workspace(): { cwd: string; agentDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegateau-config-"));
    return { cwd: (fs.mkdirSync(path.join(root, "project"), { recursive: true }), path.join(root, "project")), agentDir: path.join(root, "agent") };
  }
  function write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
  }

  it("applies the global config when the project has none", () => {
    const { cwd, agentDir } = workspace();
    write(path.join(agentDir, "delegateau.json"), { selection: "jev", delegationDecision: "jev-enforce", mode: "coordinator-only", preference: "quality" });
    const resolved = resolveConfig({ cwd, agentDir, env: {} });
    expect(resolved.source).toBe("global");
    expect(resolved.config).toMatchObject({ selection: "jev", delegationDecision: "jev-enforce", mode: "coordinator-only", preference: "quality" });
  });

  it("uses the project config instead of the global one when both exist", () => {
    const { cwd, agentDir } = workspace();
    write(path.join(agentDir, "delegateau.json"), { selection: "jev", preference: "quality" });
    write(path.join(cwd, CONFIG_FILE_NAME), { selection: "fixed", preference: "economy" });
    const resolved = resolveConfig({ cwd, agentDir, env: {} });
    expect(resolved.source).toBe("project");
    expect(resolved.config.selection).toBe("fixed");
    // The project file REPLACES the global one; it is not merged with it.
    expect(resolved.config.preference).toBe("economy");
  });

  it("falls back to built-in defaults when neither config exists", () => {
    const { cwd, agentDir } = workspace();
    const resolved = resolveConfig({ cwd, agentDir, env: {} });
    expect(resolved.source).toBe("defaults");
    expect(resolved.config).toMatchObject({ selection: "fixed", delegationDecision: "manual" });
  });

  it("resolves the global agent dir from PI_CODING_AGENT_DIR like receipts do", () => {
    const { cwd, agentDir } = workspace();
    write(path.join(agentDir, "delegateau.json"), { preference: "quality" });
    expect(resolveConfig({ cwd, env: { PI_CODING_AGENT_DIR: agentDir } }).config.preference).toBe("quality");
  });

  it("still fails closed on an unreadable project config rather than silently using defaults", () => {
    const { cwd, agentDir } = workspace();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, CONFIG_FILE_NAME), "{ not json", "utf8");
    fs.mkdirSync(agentDir, { recursive: true });
    expect(() => resolveConfig({ cwd, agentDir, env: {} })).toThrow(/Unable to read/);
  });

  it("still fails closed on an unreadable global config", () => {
    const { cwd, agentDir } = workspace();
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "delegateau.json"), "{ not json", "utf8");
    expect(() => resolveConfig({ cwd, agentDir, env: {} })).toThrow(/Unable to read/);
  });
});