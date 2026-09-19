import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("Pi child process spawner", () => {
  it("launches an isolated JSON child and reports applied model evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-test-"));
    const command = join(directory, "fake-pi");
    await writeFile(
      command,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const required = ["--mode", "json", "--no-session", "--no-extensions", "--model", "fake/fast", "--tools", "read", "--append-system-prompt"];
if (!required.every((value) => args.includes(value))) process.exit(2);
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "fast", content: [{ type: "text", text: "child result" }], stopReason: "stop" } }) + "\\n");
`,
      "utf8",
    );
    await chmod(command, 0o755);

    try {
      const events: unknown[] = [];
      const result = await new PiProcessSpawner({ command }).spawn(request, (event) => events.push(event));
      expect(result).toEqual({ exitCode: 0, observedExit: true });
      expect(events).toContainEqual({ type: "assistant", text: "child result", model: "fake/fast", stopReason: "stop" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a wall-time timeout after observing child cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delegateau-test-"));
    const command = join(directory, "hanging-pi");
    await writeFile(command, "#!/usr/bin/env node\nsetInterval(() => undefined, 1000);\n", "utf8");
    await chmod(command, 0o755);

    try {
      const result = await new ChildRunner(new PiProcessSpawner({ command, killGraceMs: 100 })).run({ ...request, wallTimeMs: 30 });
      expect(result.status).toBe("timed-out");
      expect(result.observedExit).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
