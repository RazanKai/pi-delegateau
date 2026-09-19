import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiProcessSpawner } from "../src/pi-process.js";
import { ChildRunner } from "../src/runner.js";

const request = {
  model: { provider: "fake", id: "fast" },
  task: "return the bounded result",
  expectedOutput: "one sentence",
  context: "isolated context",
  instructions: "Do only the assignment.",
  tools: ["read"],
  cwd: "/tmp",
};

function procState(pid: number): string | null {
  try {
    const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return null;
  }
}

/** Wait until a pid is gone (not live, not zombie). */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = procState(pid);
    if (state === null || state === "Z" || state === "X") {
      // Z means exited but unreaped by ITS parent; for our detached group
      // members init reaps them. Treat Z as gone for liveness purposes only
      // if it disappears shortly; otherwise keep waiting until deadline.
      if (state === null) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return procState(pid) === null;
}

async function makeFakePi(dir: string, body: string): Promise<string> {
  const command = join(dir, "fake-pi");
  await writeFile(command, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(command, 0o755);
  return command;
}

describe("Pi child process spawner", () => {
  it("launches an isolated JSON child and reports applied model evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-test-"));
    const command = await makeFakePi(
      directory,
      `const args = process.argv.slice(2);
const required = ["--mode", "json", "--no-session", "--no-extensions", "--model", "fake/fast", "--tools", "read", "--append-system-prompt"];
if (!required.every((value) => args.includes(value)) || args.includes("-e")) process.exit(2);
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fast", responseModel: "fake/fast-served", content: [{ type: "text", text: "child result" }], stopReason: "stop" } }) + "\\n");`,
    );

    try {
      const events: unknown[] = [];
      const result = await new PiProcessSpawner({ command }).spawn(request, (event) => events.push(event));
      expect(result).toMatchObject({ exitCode: 0, observedExit: true, processStarted: true, groupCleaned: true });
      expect(events).toContainEqual({ type: "assistant", text: "child result", model: "fake/fast", responseModel: "fake/fast-served", stopReason: "stop" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps discovery disabled while adding each explicit extension entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-extensions-"));
    const first = join(directory, "first.ts");
    const second = join(directory, "second.js");
    await writeFile(first, "", "utf8");
    await writeFile(second, "", "utf8");
    const command = await makeFakePi(
      directory,
      `const args = process.argv.slice(2);
const entries = args.flatMap((value, index) => value === "-e" ? [args[index + 1]] : []);
if (!args.includes("--no-extensions") || JSON.stringify(entries) !== JSON.stringify([${JSON.stringify(first)}, ${JSON.stringify(second)}])) process.exit(6);
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fast", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }) + "\\n");`,
    );
    try {
      const result = await new PiProcessSpawner({ command }).spawn({ ...request, extensionPaths: [first, second] }, () => undefined);
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("passes --thinking when a child thinking level is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-thinking-"));
    const command = await makeFakePi(
      directory,
      `const args = process.argv.slice(2);
if (!args.includes("--thinking") || args[args.indexOf("--thinking") + 1] !== "low") process.exit(5);
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fast", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }) + "\\n");`,
    );
    try {
      const result = await new PiProcessSpawner({ command }).spawn({ ...request, thinking: "low" }, () => undefined);
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // F04 regression: a descendant that ignores SIGTERM must not survive a
  // timeout, even though the direct child dies on SIGTERM. Readiness-driven:
  // the descendant is fully spawned and reporting before the wall clock trips.
  it("terminates a SIGTERM-ignoring descendant on timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-descendant-"));
    const command = await makeFakePi(
      directory,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>undefined,1000);"], { stdio: "ignore" });
fs.writeFileSync("descendant.pid", String(child.pid));
// Signal readiness, then stay alive until SIGTERM (which we do not ignore).
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "ready" }) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1000);`,
    );

    try {
      const result = await new ChildRunner(new PiProcessSpawner({ command, killGraceMs: 300 })).run({ ...request, cwd: directory, wallTimeMs: 400 });
      expect(result).toMatchObject({ status: "timed-out", observedExit: true, processStarted: true, groupCleaned: true });
      const pid = Number(await readFile(join(directory, "descendant.pid"), "utf8"));
      expect(await waitForExit(pid, 5_000)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  // F04 regression: normal exit must also sweep the process group.
  it("sweeps a surviving descendant on normal child exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-normal-"));
    const command = await makeFakePi(
      directory,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>undefined,1000);"], { stdio: "ignore" });
fs.writeFileSync("descendant.pid", String(child.pid));
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fast", content: [{ type: "text", text: "done" }], stopReason: "stop" } }) + "\\n");
process.exit(0);`,
    );

    try {
      const result = await new ChildRunner(new PiProcessSpawner({ command, killGraceMs: 300 })).run({ ...request, cwd: directory });
      expect(result).toMatchObject({ status: "success", groupCleaned: true });
      const pid = Number(await readFile(join(directory, "descendant.pid"), "utf8"));
      expect(await waitForExit(pid, 5_000)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  // F04 regression: cancellation must sweep the group too.
  it("sweeps a surviving descendant on cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-cancel-"));
    const command = await makeFakePi(
      directory,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>undefined,1000);"], { stdio: "ignore" });
fs.writeFileSync("descendant.pid", String(child.pid));
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "ready" }) + "\\n");
setInterval(() => undefined, 1000);`,
    );

    try {
      const controller = new AbortController();
      const result = await new ChildRunner(new PiProcessSpawner({ command, killGraceMs: 300 })).run(
        { ...request, cwd: directory, wallTimeMs: 60_000, signal: controller.signal },
        (text) => { if (text.includes("ready")) controller.abort(); },
      );
      expect(result.status).toBe("cancelled");
      const pid = Number(await readFile(join(directory, "descendant.pid"), "utf8"));
      expect(await waitForExit(pid, 5_000)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("reports a wall-time timeout after observing child cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-test-"));
    const command = await makeFakePi(directory, `setInterval(() => undefined, 1000);`);

    try {
      const result = await new ChildRunner(new PiProcessSpawner({ command, killGraceMs: 100 })).run({ ...request, wallTimeMs: 30 });
      expect(result.status).toBe("timed-out");
      expect(result.observedExit).toBe(true);
      expect(result.groupCleaned).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});