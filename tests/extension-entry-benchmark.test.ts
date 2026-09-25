import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { resetJevClientCache } from "../src/jev-client.js";

const benchmark = {
  model: { provider: "fake", id: "child-model" },
  source: "livebench-official",
  sourceUrl: "https://livebench.github.io/",
  benchmark: "LiveBench",
  version: "2026-01-08",
  metric: "coding-average",
  date: "2026-01-08",
  dateKind: "source-reported",
  provenance: "independent" as const,
  score: 72.5,
  unit: "percent",
  direction: "higher-is-better" as const,
};

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
  let activeTools = ["read", "write", "bash", "delegate_task"];
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: () => undefined,
    on: (name: string, handler: any) => handlers.set(name, handler),
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => { activeTools = next; },
    getAllTools: () => activeTools.map((name) => ({ name })),
  };
  extension(pi);
  return { tools, handlers };
}

async function writeChild(path: string, applied = { provider: "fake", id: "child-model" }): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",provider:${JSON.stringify(applied.provider)},model:${JSON.stringify(applied.id)},content:[{type:"text",text:"child completed"}],stopReason:"stop"}})+"\\n");
`, "utf8");
  await chmod(path, 0o755);
}

async function baseConfig(cwd: string, fakePi: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "delegateau.json"), JSON.stringify({
    defaultModel: { provider: "fake", id: "child-model" },
    candidates: [{ provider: "fake", id: "child-model", description: "measured child", capabilities: ["code"], provenance: "user", benchmarks: [benchmark] }],
    agents: { worker: { instructions: "Trusted instructions only.", tools: ["read"] } },
    piCommand: fakePi,
    receiptPath: join(cwd, "receipts.jsonl"),
    health: { path: join(cwd, "health.json") },
    ...extra,
  }), "utf8");
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  resetJevClientCache();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
});

describe("registered dispatch route evidence for benchmark records", () => {
  it("records the exact configured records with offered:false when no chooser runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-bench-fixed-"));
    const fakePi = join(cwd, "fake-pi");
    await writeChild(fakePi);
    await baseConfig(cwd, fakePi, { selection: "fixed" });

    try {
      const { tools } = await harness();
      await tools[0].execute("bench-fixed", { agent: "worker", task: "SECRET_TASK" }, undefined, undefined, makeContext(cwd));
      const receipt = JSON.parse((await readFile(join(cwd, "receipts.jsonl"), "utf8")).trim());
      expect(receipt.routeTrace.benchmarks).toEqual({ offeredToJev: false, records: [benchmark], offeredCount: 1, truncated: false });
      expect(JSON.stringify(receipt.routeTrace)).not.toContain("SECRET_TASK");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it("records offered:true only when the real Jev chooser was invoked for the dispatch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-bench-jev-"));
    const fakePi = join(cwd, "fake-pi");
    await writeChild(fakePi);
    await baseConfig(cwd, fakePi, {
      selection: "jev",
      allowExternalSensing: true,
      delegationDecision: "manual",
      candidates: [
        { provider: "fake", id: "child-model", description: "measured child", capabilities: ["code"], provenance: "user", benchmarks: [benchmark] },
        { provider: "fake", id: "other-model", description: "unmeasured sibling", capabilities: ["code"], provenance: "user" },
      ],
    });

    // A local TypeSafe-compatible endpoint proves the real SDK transport path
    // (no client mock): the extension builds its own TypeSafeClient from env.
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        expect(parsed.model).toBe("jev-latest");
        expect(parsed.state.candidates[0].benchmarks).toEqual([benchmark]);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ answers: { selected_model: { choice: "fake/child-model", probabilities: { "fake/child-model": 0.7, "fake/other-model": 0.3 }, confidence: 0.9 } }, usage: { input_tokens: 10, output_tokens: 5 } }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${port}`;
    resetJevClientCache();

    try {
      const { tools } = await harness();
      const result = await tools[0].execute("bench-jev", { agent: "worker", task: "SECRET_TASK" }, undefined, undefined, makeContext(cwd));
      expect(result.details).toMatchObject({ status: "success", selectedModel: { provider: "fake", id: "child-model" } });
      const receipt = JSON.parse((await readFile(join(cwd, "receipts.jsonl"), "utf8")).trim());
      expect(receipt.routeTrace.selectionSource).toBe("jev");
      expect(receipt.routeTrace.benchmarks).toEqual({ offeredToJev: true, records: [benchmark], offeredCount: 1, truncated: false });
      expect(JSON.stringify(receipt.routeTrace)).not.toContain("SECRET_TASK");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
