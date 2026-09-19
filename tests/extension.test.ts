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
    expect(activeTools).toEqual(["delegate_task", "ask_user"]);
    await expect(handlers.get("tool_call")({ toolName: "write" }, ctx)).resolves.toMatchObject({ block: true });
    await expect(handlers.get("tool_call")({ toolName: "delegate_task" }, ctx)).resolves.toBeUndefined();
    expect(notifications.at(-1)).toContain("coordinator-only");
  });
});
