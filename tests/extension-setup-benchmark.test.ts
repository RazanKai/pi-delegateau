import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

const record = {
  model: { provider: "fake", id: "child-model" },
  source: "livebench-official",
  sourceUrl: "https://livebench.github.io/",
  benchmark: "LiveBench",
  version: "2026-01-08",
  metric: "coding-average",
  date: "2026-01-08",
  dateKind: "source-reported",
  provenance: "independent",
  score: 72.5,
  unit: "percent",
  direction: "higher-is-better",
};

function makeContext(cwd: string, notifications: Array<{ message: string; level: string }>) {
  return {
    cwd,
    mode: "print" as const,
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
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
    model: { provider: "parent", id: "parent-model" },
    scopedModels: [],
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "base",
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
      getAvailable: () => [
        { provider: "fake", id: "child-model", contextWindow: 1_000, maxTokens: 100 },
        { provider: "fake", id: "other-model", contextWindow: 1_000, maxTokens: 100 },
      ],
    },
  } as any;
}

async function harness() {
  const commands = new Map<string, any>();
  const pi: any = {
    registerTool: () => undefined,
    registerCommand: (name: string, spec: any) => commands.set(name, spec.handler),
    on: () => undefined,
    getActiveTools: () => ["read", "bash", "delegate_task"],
    setActiveTools: () => undefined,
    getAllTools: () => [{ name: "read" }],
  };
  extension(pi);
  return { commands };
}

let priorAgentDir: string | undefined;
let priorKey: string | undefined;

beforeEach(() => {
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  priorKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
});

afterEach(() => {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  if (priorKey === undefined) delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  else process.env.ARTIFICIAL_ANALYSIS_API_KEY = priorKey;
});

describe("explicit setup benchmark commands", () => {
  it("imports a local document into agent-state cache and reports measured counts, with no network", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-setup-import-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-delegateau-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    const importFile = join(cwd, "evidence.json");
    await writeFile(importFile, JSON.stringify({ version: 1, records: [record] }), "utf8");
    try {
      const { commands } = await harness();
      const notifications: Array<{ message: string; level: string }> = [];
      const ctx = makeContext(cwd, notifications);
      await commands.get("delegateau")(`setup import ${importFile}`, ctx);

      const imported = notifications.find((entry) => entry.message.includes("setup import"));
      expect(imported?.message).toContain("1 record");
      expect(imported?.message.toLowerCase()).toContain("no network");

      const cacheFile = join(agentDir, "delegateau", "benchmarks.json");
      expect(existsSync(cacheFile)).toBe(true);
      const cache = JSON.parse(await readFile(cacheFile, "utf8"));
      expect(cache.records).toHaveLength(1);
      expect(cache.records[0]).toMatchObject({ metric: "coding-average", source: "livebench-official" });

      // Ordinary review re-reads and revalidates the cache with no network.
      notifications.length = 0;
      await commands.get("delegateau")("setup", ctx);
      const review = notifications.find((entry) => entry.message.includes("setup review"));
      expect(review?.message).toContain("1 measured");
      expect(review?.message).toContain("1 unmeasured");
      expect(review?.message).toContain("import");
      expect(review?.message).toContain("retrieve artificial-analysis");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reports the absent Artificial Analysis credential as unavailable without claiming records", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-setup-retrieve-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-delegateau-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    const mappingFile = join(cwd, "mapping.json");
    await writeFile(mappingFile, JSON.stringify({ source: "artificial-analysis", mappings: [{ sourceId: "aa-1", provider: "fake", id: "child-model" }] }), "utf8");
    try {
      const { commands } = await harness();
      const notifications: Array<{ message: string; level: string }> = [];
      await commands.get("delegateau")(`setup retrieve artificial-analysis ${mappingFile}`, makeContext(cwd, notifications));
      const message = notifications.map((entry) => entry.message).join("\n");
      expect(message).toContain("ARTIFICIAL_ANALYSIS_API_KEY");
      expect(message).toMatch(/no request|unavailable|absent/i);
      expect(existsSync(join(agentDir, "delegateau", "benchmarks.json"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported retrieval source without fetching", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-setup-source-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-delegateau-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const { commands } = await harness();
      const notifications: Array<{ message: string; level: string }> = [];
      await commands.get("delegateau")("setup retrieve made-up-source /tmp/whatever.json", makeContext(cwd, notifications));
      const message = notifications.map((entry) => entry.message).join("\n");
      expect(message).toContain("unsupported");
      expect(message).toContain("artificial-analysis");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not write the cache when a credentialed retrieval fails or is empty", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-setup-retrieve-fail-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-delegateau-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "test-secret-key";
    const mappingFile = join(cwd, "mapping.json");
    await writeFile(mappingFile, JSON.stringify({ source: "artificial-analysis", mappings: [{ sourceId: "aa-1", provider: "fake", id: "child-model" }] }), "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));
    try {
      const { commands } = await harness();
      const notifications: Array<{ message: string; level: string }> = [];
      await commands.get("delegateau")(`setup retrieve artificial-analysis ${mappingFile}`, makeContext(cwd, notifications));
      const message = notifications.map((entry) => entry.message).join("\n");
      expect(message).toMatch(/no cache was written/i);
      expect(message).not.toContain("test-secret-key");
      expect(existsSync(join(agentDir, "delegateau", "benchmarks.json"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("requires a second explicit overwrite confirmation before replacing an existing config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-delegateau-setup-overwrite-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-delegateau-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configPath = join(cwd, ".pi", "delegateau.json");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const original = `${JSON.stringify({ marker: "original" })}\n`;
    await writeFile(configPath, original, "utf8");
    try {
      const { commands } = await harness();
      const notifications: Array<{ message: string; level: string }> = [];
      // First confirmation accepts the review; the second (overwrite) declines.
      const ctx = makeContext(cwd, notifications);
      ctx.ui.confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await commands.get("delegateau")("setup apply", ctx);
      expect(await readFile(configPath, "utf8")).toBe(original);
      expect(notifications.map((entry) => entry.message).join("\n")).toMatch(/not confirmed/);

      // Both affirmations replace the file.
      const ctx2 = makeContext(cwd, notifications);
      ctx2.ui.confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      await commands.get("delegateau")("setup apply", ctx2);
      const written = JSON.parse(await readFile(configPath, "utf8"));
      expect(written.selection).toBe("jev");
      expect(written.marker).toBeUndefined();
      expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
