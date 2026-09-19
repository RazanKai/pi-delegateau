import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

describe("Pi extension entry point", () => {
  it("registers the delegation tool, status command, and call-time enforcement hook", async () => {
    const tools: any[] = [];
    const commands = new Map<string, any>();
    const handlers = new Map<string, any>();
    let activeTools = ["read", "write", "bash"];
    const notifications: string[] = [];
    const pi: any = {
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, handler: any) => handlers.set(name, handler),
      getActiveTools: () => activeTools,
      setActiveTools: (next: string[]) => { activeTools = next; },
      getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "bash" }, { name: "delegate_task" }],
    };
    extension(pi);

    expect(tools.map((tool) => tool.name)).toContain("delegate_task");
    expect(commands.has("delegateau")).toBe(true);
    const ctx = { cwd: "/tmp", ui: { setStatus: () => undefined, notify: (text: string) => notifications.push(text) } };
    await commands.get("delegateau").handler("enable coordinator-only", ctx);
    // coordinator-only admits only delegation; recovery is via the command
    // surface and conversation, not a nonexistent ask_user tool.
    expect(activeTools).toEqual(["delegate_task"]);
    await expect(handlers.get("tool_call")({ toolName: "write" }, ctx)).resolves.toMatchObject({ block: true });
    await expect(handlers.get("tool_call")({ toolName: "delegate_task" }, ctx)).resolves.toBeUndefined();
    expect(notifications.at(-1)).toContain("coordinator-only");
    await commands.get("delegateau").handler("disable", ctx);
    expect(activeTools).toEqual(["read", "write", "bash"]);
  });

  // F03 regression: delegation from an untrusted project is refused before
  // any config read or child launch.
  it("refuses delegation when the host reports the project untrusted", async () => {
    const tools: any[] = [];
    const handlers = new Map<string, any>();
    const pi: any = {
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => undefined,
      on: (name: string, handler: any) => handlers.set(name, handler),
      getActiveTools: () => ["read"],
      setActiveTools: () => undefined,
      getAllTools: () => [{ name: "read" }],
    };
    extension(pi);
    const tool = tools.find((candidate) => candidate.name === "delegate_task")!;
    const ctx = {
      cwd: "/tmp",
      isProjectTrusted: () => false,
      ui: { notify: () => undefined, setStatus: () => undefined },
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
    };
    await expect(tool.execute("call-1", { agent: "worker", task: "x" }, undefined, undefined, ctx)).rejects.toThrow(/not trusted/i);
  });

  // F12 regression: a failed child surfaces as a Pi tool error via the
  // thrown error channel, not a fulfilled non-error result.
  it("surfaces child failures through the error channel", async () => {
    const { chmod, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-entry-"));
    const failing = join(directory, "failing-pi");
    await writeFile(failing, "#!/usr/bin/env node\nprocess.exit(3);\n", "utf8");
    await chmod(failing, 0o755);
    const { mkdir, writeFile: writeFile2 } = await import("node:fs/promises");
    await mkdir(join(directory, ".pi"), { recursive: true });
    await writeFile2(join(directory, ".pi", "delegateau.json"), JSON.stringify({
      selection: "fixed",
      defaultModel: { provider: "fake", id: "child" },
      candidates: [{ provider: "fake", id: "child", description: "c", capabilities: [], provenance: "user" }],
      agents: { worker: { instructions: "i", tools: ["read"] } },
      piCommand: failing,
      receiptPath: join(directory, "receipts.jsonl"),
      decisionReceiptPath: join(directory, "decisions.jsonl"),
    }), "utf8");

    const tools: any[] = [];
    const pi: any = {
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => undefined,
      on: () => undefined,
      getActiveTools: () => ["read"],
      setActiveTools: () => undefined,
      getAllTools: () => [{ name: "read" }],
    };
    extension(pi);
    const tool = tools.find((candidate) => candidate.name === "delegate_task")!;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      ui: { notify: () => undefined, setStatus: () => undefined },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
      model: { provider: "parent", id: "pm" },
      getSystemPrompt: () => "",
    };
    try {
      await tool.execute("call-1", { agent: "worker", task: "x" }, undefined, undefined, ctx);
      expect.unreachable("execute should have thrown");
    } catch (error) {
      expect((error as any).payload?.details?.status ?? (error as Error).message).toMatch(/failed|launch-error/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});