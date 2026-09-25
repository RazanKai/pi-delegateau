import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { HealthStore } from "../src/health-store.js";

function makeContext(cwd: string) {
  return {
    cwd,
    mode: "print" as const,
    hasUI: false,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      onTerminalInput: () => () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme: {} as any,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    },
    model: { provider: "parent", id: "parent-model", reasoning: true },
    scopedModels: [],
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "base system prompt",
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
    },
  } as any;
}

async function harness() {
  const tools: any[] = [];
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  let activeTools = ["read", "write", "bash", "delegate_task"];
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, spec: any) => commands.set(name, spec.handler),
    on: (name: string, handler: any) => handlers.set(name, handler),
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => { activeTools = next; },
    getAllTools: () => activeTools.map((name) => ({ name })),
  };
  extension(pi);
  return { tools, handlers, commands };
}

async function writeFailurePi(path: string, spawnLog: string, applied?: { provider: string; id: string }): Promise<void> {
  const message = {
    role: "assistant",
    provider: applied?.provider ?? "fake",
    model: applied?.id ?? "child-model",
    content: [{ type: "text", text: "provider failure body" }],
    stopReason: "error",
    errorMessage: "429 rate limit exceeded: SECRET-PROVIDER-BODY",
  };
  await writeFile(path, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");
process.stdout.write(${JSON.stringify(JSON.stringify({ type: "message_end", message }))} + "\\n");
`, "utf8");
  await chmod(path, 0o755);
}

describe("persistent runtime health through the registered delegate_task path", () => {
  it("remembers a provider failure across calls and filters the open circuit before launch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-health-"));
    const fakePi = join(cwd, "fake-pi");
    const spawnLog = join(cwd, "spawns.log");
    const healthFile = join(cwd, "health.json");
    await writeFailurePi(fakePi, spawnLog);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "delegateau.json"), JSON.stringify({
      selection: "fixed",
      defaultModel: { provider: "fake", id: "child-model" },
      candidates: [{ provider: "fake", id: "child-model", description: "test child", capabilities: ["code"], provenance: "user" }],
      agents: { worker: { instructions: "Trusted instructions only.", tools: ["read"] } },
      health: { failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60, path: healthFile },
      piCommand: fakePi,
      receiptPath: join(cwd, "receipts.jsonl"),
    }), "utf8");

    try {
      const { tools } = await harness();
      const ctx = makeContext(cwd);
      let firstError: any;
      try {
        await tools[0].execute("first", { agent: "worker", task: "A" }, undefined, undefined, ctx);
      } catch (error) {
        firstError = error;
      }
      expect(firstError?.payload?.details?.status).toBe("failed");

      // The failure must be remembered: the circuit is persisted as open.
      expect(existsSync(healthFile)).toBe(true);
      const health = JSON.parse(await readFile(healthFile, "utf8"));
      expect(health.models["fake/child-model"]?.lastFailureCategory).toBe("quota");
      expect(health.models["fake/child-model"]?.openUntil).toBeGreaterThan(Date.now());

      // A later call must exclude the open circuit before launching a child.
      let secondError: any;
      try {
        await tools[0].execute("second", { agent: "worker", task: "B" }, undefined, undefined, ctx);
      } catch (error) {
        secondError = error;
      }
      expect(secondError?.payload?.details?.status).toBe("launch-error");
      const spawns = (await readFile(spawnLog, "utf8")).trim().split("\n").filter(Boolean);
      expect(spawns).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it("reports open circuits in /delegateau status with sanitized facts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-status-"));
    const healthFile = join(cwd, "health.json");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "delegateau.json"), JSON.stringify({
      health: { failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60, path: healthFile },
    }), "utf8");
    try {
      const { commands } = await harness();
      const notifications: Array<{ message: string; level: string }> = [];
      const ctx = makeContext(cwd);
      ctx.ui.notify = (message: string, level: string) => notifications.push({ message, level });
      new HealthStore({ path: healthFile, config: { failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 } })
        .recordFailure("alpha/one", "quota", Date.now());
      await commands.get("delegateau")("status", ctx);
      const status = notifications.find((entry) => entry.message.includes("pi-delegateau:"));
      expect(status?.message).toContain("health=1 open circuit");
      expect(status?.message).toContain("alpha/one: quota until");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records health against the applied model when the provider substitutes one", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-subst-"));
    const fakePi = join(cwd, "fake-pi");
    const spawnLog = join(cwd, "spawns.log");
    const healthFile = join(cwd, "health.json");
    await writeFailurePi(fakePi, spawnLog, { provider: "servedprovider", id: "served-model" });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "delegateau.json"), JSON.stringify({
      selection: "fixed",
      defaultModel: { provider: "fake", id: "child-model" },
      candidates: [{ provider: "fake", id: "child-model", description: "test child", capabilities: ["code"], provenance: "user" }],
      agents: { worker: { instructions: "Trusted instructions only.", tools: ["read"] } },
      health: { failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60, path: healthFile },
      piCommand: fakePi,
      receiptPath: join(cwd, "receipts.jsonl"),
    }), "utf8");

    try {
      const { tools } = await harness();
      await tools[0].execute("subst", { agent: "worker", task: "C" }, undefined, undefined, makeContext(cwd)).catch(() => undefined);
      const exists = existsSync(healthFile);
      expect(exists).toBe(true);
      if (!exists) return;
      const health = JSON.parse(await readFile(healthFile, "utf8"));
      expect(health.models["servedprovider/served-model"]?.lastFailureCategory).toBe("quota");
      expect(health.models["fake/child-model"]).toBeUndefined();
      expect((await stat(healthFile)).size).toBeGreaterThan(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
