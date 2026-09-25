import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSetupPlan, detectWebAccessExtensions, discoverSetupCandidates, measureQuotaCost, pruneSetupCandidates, roleTemplates, setupConfig, writeSetupConfig, type BenchmarkEvidence } from "../src/onboarding.js";
import { parseConfig } from "../src/config.js";

const registry: any = { getAvailable: () => [
  { provider: "a", id: "exact/id", contextWindow: 200, maxTokens: 50, reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2 } },
  { provider: "b", id: "no-auth" },
], hasConfiguredAuth: (m: any) => m.provider === "a" };
let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("explicit onboarding", () => {
  it("turns an empty fresh install into a valid unmeasured review without hardcoded identities", () => {
    const plan = buildSetupPlan(registry);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ identity: { provider: "a", id: "exact/id" }, contextWindow: 200, maxOutputTokens: 50, reasoning: true, accessMode: "token", state: "unmeasured" });
    expect(plan.candidates[0]!.inputModalities).toEqual(["text", "image"]);
    const generated = parseConfig(setupConfig(plan));
    expect(generated.selection).toBe("jev");
    expect(generated.candidates[0]!.identity).toEqual({ provider: "a", id: "exact/id" });
  });
  it("filters configured auth through Pi registry checks", () => {
    expect(discoverSetupCandidates(registry).map((x) => x.identity.provider)).toEqual(["a"]);
    expect(() => parseConfig({ candidates: "malformed" })).toThrow(/candidates/);
  });
  it("keeps missing probe evidence and removes only confirmed unreachable models", () => {
    const candidates = discoverSetupCandidates(registry);
    expect(pruneSetupCandidates(candidates).candidates).toHaveLength(1);
    const out = pruneSetupCandidates(candidates, [], { version: 1, probedAt: new Date().toISOString(), results: [{ identity: { provider: "a", id: "exact/id" }, reachable: false, errorCategory: "auth", probedAt: new Date().toISOString() }] });
    expect(out.candidates).toEqual([]); expect(out.reasons.join(" ")).toMatch(/confirmed unreachable/);
  });
  it("only prunes dominance using comparable versioned evidence", () => {
    const base: any[] = [
      { identity: { provider: "p", id: "weak" }, description: "", capabilities: [], provenance: "built-in", cost: { input: 2 }, contextWindow: 10, accessMode: "default", state: "unmeasured" },
      { identity: { provider: "p", id: "strong" }, description: "", capabilities: [], provenance: "built-in", cost: { input: 1 }, contextWindow: 20, accessMode: "default", state: "unmeasured" },
    ];
    const evidence: BenchmarkEvidence[] = [
      { model: base[0].identity, source: "x", sourceUrl: "https://example.test/", benchmark: "bench", version: "1", metric: "coding", date: "2026-01-01", dateKind: "source-reported", provenance: "independent", score: 1, unit: "percent", direction: "higher-is-better" },
      { model: base[1].identity, source: "x", sourceUrl: "https://example.test/", benchmark: "bench", version: "1", metric: "coding", date: "2026-01-01", dateKind: "source-reported", provenance: "independent", score: 2, unit: "percent", direction: "higher-is-better" },
    ];
    expect(pruneSetupCandidates(base, evidence).candidates.map((x) => x.identity.id)).toEqual(["strong"]);
    evidence[1]!.version = "2";
    expect(pruneSetupCandidates(base, evidence).candidates).toHaveLength(2);
  });
  it("preserves every normalized record through setup config and requires dominance on every measured metric", () => {
    const base: any[] = [
      { identity: { provider: "p", id: "weak" }, description: "", capabilities: [], provenance: "built-in", cost: { input: 2 }, contextWindow: 10, accessMode: "token", accessDecision: "default", state: "unmeasured" },
      { identity: { provider: "p", id: "strong" }, description: "", capabilities: [], provenance: "built-in", cost: { input: 1 }, contextWindow: 20, accessMode: "token", accessDecision: "default", state: "unmeasured" },
    ];
    const make = (model: any, metric: string, score: number): BenchmarkEvidence => ({
      model, source: "official", sourceUrl: "https://example.test/leaderboard", benchmark: "bench", version: "2026-01", metric,
      date: "2026-01-02", dateKind: "source-reported", provenance: "independent", score, unit: "percent", direction: "higher-is-better",
    });
    const weak = [make(base[0].identity, "coding", 60), make(base[0].identity, "reasoning", 80)];
    const partialStrong = [make(base[1].identity, "coding", 70)];
    expect(pruneSetupCandidates(base, [...weak, ...partialStrong]).candidates).toHaveLength(2);

    const all = [...weak, ...partialStrong, make(base[1].identity, "reasoning", 81)];
    const pruned = pruneSetupCandidates(base, all);
    expect(pruned.candidates.map((candidate) => candidate.identity.id)).toEqual(["strong"]);
    expect(pruned.candidates[0]!.benchmarks).toHaveLength(2);
    const parsed = parseConfig(setupConfig({ candidates: pruned.candidates, agents: {}, reasons: [] }));
    expect(parsed.candidates[0]!.benchmarks).toEqual(pruned.candidates[0]!.benchmarks);
  });
  it("supports either web extension", () => {
    const missing = roleTemplates([]);
    expect(missing.agents).not.toHaveProperty("researcher");
    expect(missing.unavailable.join(" ")).toContain("pi-web-access or donsetch");
    expect(roleTemplates(["pi-web-access"]).agents.researcher).toMatchObject({ childExtensions: ["pi-web-access"] });
    expect(roleTemplates(["donsetch"]).agents.researcher).toMatchObject({ childExtensions: ["donsetch"] });
    expect(detectWebAccessExtensions([{ sourceInfo: { path: "/agent/node_modules/donsetch/pi-extension.ts" } }])).toEqual(["donsetch"]);
    expect(detectWebAccessExtensions([{ sourceInfo: { source: "pi-web-access" } }])).toEqual(["pi-web-access"]);
  });
  it("does not measure unless explicitly opted in", async () => {
    let calls = 0; expect(await measureQuotaCost(false, async () => ++calls)).toBeUndefined(); expect(calls).toBe(0);
    expect(await measureQuotaCost(true, async () => ++calls)).toBe(1);
  });
  it("requires confirmation and never serializes credential-shaped input", () => {
    dir = mkdtempSync(join(tmpdir(), "delegateau-setup-")); const config = setupConfig(buildSetupPlan(registry));
    expect(writeSetupConfig(dir, config, false)).toBeUndefined(); expect(existsSync(join(dir, ".pi", "delegateau.json"))).toBe(false);
    const written = writeSetupConfig(dir, config, true); expect(written).toBeTruthy();
    expect(readFileSync(written!, "utf8")).not.toMatch(/api[_-]?key|secret|credential/i);
    expect(writeSetupConfig(dir, config, true)).toBeUndefined();
  });
});
