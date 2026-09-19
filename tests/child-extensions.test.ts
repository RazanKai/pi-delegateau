import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChildExtensions, validateProbedChildTools } from "../src/child-extensions.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "delegateau-ext-"));
  cleanup.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

async function makePackage(root: string, name: string, entry = "./entry.ts"): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: { extensions: [entry] } }), "utf8");
  await mkdir(dirname(join(root, entry)), { recursive: true });
  await writeFile(join(root, entry), "export default function() {}\n", "utf8");
  return join(root, entry);
}

describe("child extension resolution", () => {
  it("resolves the concrete manifest entry from global Pi package settings", async () => {
    const { root, cwd, agentDir } = await workspace();
    const packageRoot = join(root, "odd-layout");
    const entry = await makePackage(packageRoot, "pi-lens-fixture", "./built/not-index.js");
    // The manifest deliberately does not use a conventional index filename.
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }), "utf8");

    await expect(resolveChildExtensions(["pi-lens-fixture"], cwd, agentDir)).resolves.toMatchObject({ paths: [entry] });
  });

  it("uses Pi manifest glob expansion instead of guessing an entry filename", async () => {
    const { root, cwd, agentDir } = await workspace();
    const packageRoot = join(root, "glob-package");
    await mkdir(join(packageRoot, "extensions"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "glob-package", pi: { extensions: ["./extensions/*.ts"] } }), "utf8");
    const first = join(packageRoot, "extensions", "alpha.ts");
    const second = join(packageRoot, "extensions", "beta.ts");
    await writeFile(first, "export default function() {}\n", "utf8");
    await writeFile(second, "export default function() {}\n", "utf8");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }), "utf8");

    const resolved = await resolveChildExtensions(["glob-package"], cwd, agentDir);
    expect(resolved.paths.sort()).toEqual([first, second]);
  });

  it("uses the project package when the same npm identity exists globally and locally", async () => {
    const { cwd, agentDir } = await workspace();
    const globalRoot = join(agentDir, "npm", "node_modules", "same-pkg");
    const projectRoot = join(cwd, ".pi", "npm", "node_modules", "same-pkg");
    await makePackage(globalRoot, "same-pkg", "./global.ts");
    const projectEntry = await makePackage(projectRoot, "same-pkg", "./project.ts");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:same-pkg"] }), "utf8");
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:same-pkg"] }), "utf8");

    await expect(resolveChildExtensions(["same-pkg"], cwd, agentDir)).resolves.toMatchObject({ paths: [projectEntry] });
  });

  it("fails closed for unknown names, missing paths, undeclared paths and delegateau", async () => {
    const { root, cwd, agentDir } = await workspace();
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }), "utf8");
    await expect(resolveChildExtensions(["missing"], cwd, agentDir)).rejects.toThrow("could not be resolved");
    await expect(resolveChildExtensions([join(root, "missing.ts")], cwd, agentDir)).rejects.toThrow("does not exist");

    const noManifestEntry = join(root, "no-extension");
    await mkdir(noManifestEntry);
    await writeFile(join(noManifestEntry, "package.json"), JSON.stringify({ name: "no-extension" }), "utf8");
    await expect(resolveChildExtensions([noManifestEntry], cwd, agentDir)).rejects.toThrow("no pi.extensions");
    await expect(resolveChildExtensions([process.cwd()], cwd, agentDir)).rejects.toThrow("pi-delegateau cannot");
  });

  it("accepts only built-ins or tools attributed to the selected extension entry", () => {
    const extensionPath = "/tmp/package/entry.ts";
    expect(validateProbedChildTools(["read", "lens_diagnostics"], [extensionPath], [
      { name: "read", source: { source: "builtin", path: "<builtin:read>" } },
      { name: "lens_diagnostics", source: { source: "npm:pi-lens", path: extensionPath } },
    ])).toEqual(["read", "lens_diagnostics"]);
    expect(() => validateProbedChildTools(["unknown"], [extensionPath], [])).toThrow("unknown");
    expect(() => validateProbedChildTools(["delegate_task"], [extensionPath], [
      { name: "delegate_task", source: { source: "npm:pi-delegateau", path: extensionPath } },
    ])).toThrow("delegate_task");
  });

  it("keeps absent allowlists empty without reading settings", async () => {
    await expect(resolveChildExtensions([], "/path/that/does/not/exist", "/also/missing")).resolves.toEqual({ paths: [], packageNames: [] });
  });
});
