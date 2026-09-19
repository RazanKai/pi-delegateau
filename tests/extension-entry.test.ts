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
      const decisionLines = (await readFile(decisions, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(decisionLines.at(-1)).toMatchObject({ outcome: "delegated", execution: "delegated" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
