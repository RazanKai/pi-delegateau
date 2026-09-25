import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

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

describe("real extension dispatch path", () => {
  it("runs a configured child in a disposable non-git workspace and records linked receipts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-entry-"));
    const fakePi = join(cwd, "fake-pi");
    const receipts = join(cwd, "receipts.jsonl");
    const decisions = join(cwd, "decisions.jsonl");
    await writeFile(join(cwd, ".pi-placeholder"), "not a git repository\n", "utf8");
    await writeFile(fakePi, `#!/usr/bin/env node
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--append-system-prompt");
if (!args.includes("--no-session") || !args.includes("--no-extensions") || promptIndex < 0) process.exit(3);
const fs = require("node:fs");
const trusted = fs.readFileSync(args[promptIndex + 1], "utf8");
if (trusted.includes("SECRET_TASK")) process.exit(4);
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"fake",model:"child-model",content:[{type:"text",text:"child completed"}],stopReason:"stop"}})+"\\n");
`, "utf8");
    await chmod(fakePi, 0o755);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "delegateau.json"), JSON.stringify({
      selection: "fixed",
      defaultModel: { provider: "fake", id: "child-model" },
      candidates: [{ provider: "fake", id: "child-model", description: "test child", capabilities: ["code"], provenance: "user" }],
      agents: { worker: { instructions: "Trusted instructions only.", tools: ["read"] } },
      piCommand: fakePi,
      receiptPath: receipts,
      decisionReceiptPath: decisions,
      // Keep health state in the disposable workspace, never the real agent dir.
      health: { path: join(cwd, "health.json") },
    }), "utf8");

    try {
      const tools: any[] = [];
      const handlers = new Map<string, any>();
      let activeTools = ["read", "write", "bash", "delegate_task", "ask_user"];
      const pi: any = {
        registerTool: (tool: any) => tools.push(tool),
        registerCommand: () => undefined,
        on: (name: string, handler: any) => handlers.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (next: string[]) => { activeTools = next; },
        getAllTools: () => activeTools.map((name) => ({ name })),
      };
      extension(pi);
      const ctx = makeContext(cwd);
      await handlers.get("before_agent_start")({ prompt: "Build it", systemPrompt: "base" }, ctx);
      const result = await tools[0].execute("call-1", { agent: "worker", task: "SECRET_TASK", expectedOutput: "child completed" }, undefined, undefined, ctx);
      await handlers.get("agent_settled")({}, ctx);

      expect(result.details).toMatchObject({ status: "success", selectedModel: { provider: "fake", id: "child-model" }, appliedModel: { provider: "fake", id: "child-model" } });
      expect(JSON.stringify(result)).toContain("child completed");
      const dispatchReceipt = JSON.parse((await readFile(receipts, "utf8")).trim());
      expect(dispatchReceipt).toMatchObject({ outcome: "success", decisionId: expect.any(String) });
      // The structured route trace rides along the existing receipt path and
      // must never carry the task text.
      expect(dispatchReceipt.routeTrace).toMatchObject({
        dispatchId: dispatchReceipt.dispatchId,
        decisionId: dispatchReceipt.decisionId,
        agent: "worker",
        selectionSource: "fixed",
        selectedModel: "fake/child-model",
        appliedModel: "fake/child-model",
        outcome: "success",
        candidateIds: ["fake/child-model"],
      });
      expect(JSON.stringify(dispatchReceipt.routeTrace)).not.toContain("SECRET_TASK");
      const decisionLines = (await readFile(decisions, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(decisionLines.at(-1)).toMatchObject({ outcome: "delegated", execution: "delegated" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs a batch in parallel, queues overflow with position updates, and writes one receipt per assignment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-batch-"));
    const fakePi = join(cwd, "fake-pi");
    const receipts = join(cwd, "receipts.jsonl");
    const timeline = join(cwd, "timeline.jsonl");
    await writeFile(fakePi, `#!/usr/bin/env node
const fs = require("node:fs");
const path = ${JSON.stringify(timeline)};
const task = process.argv.at(-1);
const now = () => new Date().toISOString();
fs.appendFileSync(path, JSON.stringify({ event: "start", task, at: now(), pid: process.pid }) + "\\n");
function starts() { return fs.readFileSync(path, "utf8").trim().split("\\n").map(JSON.parse).filter(e => e.event === "start").length; }
function finish() {
  fs.appendFileSync(path, JSON.stringify({ event: "end", task, at: now(), pid: process.pid }) + "\\n");
  if (task === "FAIL") return process.exit(2);
  process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"fake",model:"child-model",content:[{type:"text",text:"done " + task}],stopReason:"stop"}})+"\\n");
}
if (task === "A" || task === "B") {
  const wait = () => starts() >= 2 ? finish() : setTimeout(wait, 10);
  wait();
} else finish();
`, "utf8");
    await chmod(fakePi, 0o755);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "delegateau.json"), JSON.stringify({
      selection: "fixed",
      defaultModel: { provider: "fake", id: "child-model" },
      candidates: [{ provider: "fake", id: "child-model" }],
      agents: { worker: { instructions: "Work.", tools: ["read"] } },
      limits: { concurrency: 2, maxQueueDepth: 2 },
      piCommand: fakePi,
      receiptPath: receipts,
      health: { path: join(cwd, "health.json") },
    }), "utf8");

    try {
      const tools: any[] = [];
      const handlers = new Map<string, any>();
      let activeTools = ["read", "delegate_task"];
      const pi: any = {
        registerTool: (tool: any) => tools.push(tool),
        registerCommand: () => undefined,
        on: (name: string, handler: any) => handlers.set(name, handler),
        getActiveTools: () => activeTools,
        setActiveTools: (next: string[]) => { activeTools = next; },
        getAllTools: () => activeTools.map((name) => ({ name })),
      };
      extension(pi);
      const updates: any[] = [];
      const result = await tools[0].execute("batch", { assignments: [
        { agent: "worker", task: "A" },
        { agent: "worker", task: "B" },
        { agent: "worker", task: "C" },
      ] }, undefined, (update: any) => updates.push(update), makeContext(cwd));

      expect(result.details).toMatchObject({ status: "success", dispatches: [{ status: "success" }, { status: "success" }, { status: "success" }] });
      expect(new Set(result.details.dispatches.map((item: any) => item.dispatchId)).size).toBe(3);
      expect(updates.some((update) => update.details.status === "queued" && update.details.queuePosition === 1)).toBe(true);
      const events = (await readFile(timeline, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const firstEnd = events.findIndex((event) => event.event === "end");
      expect(events.slice(0, firstEnd).filter((event) => event.event === "start").map((event) => event.task).sort()).toEqual(["A", "B"]);
      expect(events.findIndex((event) => event.event === "start" && event.task === "C")).toBeGreaterThan(firstEnd);

      let mixedError: any;
      try {
        await tools[0].execute("mixed", { assignments: [
          { agent: "worker", task: "D" },
          { agent: "worker", task: "FAIL" },
        ] }, undefined, undefined, makeContext(cwd));
      } catch (error) {
        mixedError = error;
      }
      expect(mixedError?.payload?.details).toMatchObject({ status: "partial-failure", dispatches: [{ status: "success" }, { status: "failed" }] });
      expect((await readFile(receipts, "utf8")).trim().split("\n")).toHaveLength(5);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
