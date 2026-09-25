import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthStore, loadHealthState, saveHealthState, type HealthIo } from "../src/health-store.js";
import { emptyHealthState, type HealthState } from "../src/health.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delegateau-health-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function memoryIo(): { io: HealthIo; read: () => HealthState | undefined } {
  let stored: HealthState | undefined;
  return {
    io: {
      load: () => (stored ? structuredClone(stored) : emptyHealthState()),
      save: (_path, state) => { stored = structuredClone(state); },
    },
    read: () => stored,
  };
}

const CONFIG = { failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };

describe("health persistence facade", () => {
  it("round-trips through disk with human-readable JSON", () => {
    const path = join(dir, "nested", "health.json");
    const store = new HealthStore({ path, config: CONFIG, now: () => 1_000_000 });
    store.recordFailure("alpha/one", "quota", 1_000_000);

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("\n  \"models\"");
    const reloaded = new HealthStore({ path, config: CONFIG, now: () => 1_000_000 });
    expect(reloaded.circuit("alpha/one").open).toBe(true);
    expect(reloaded.openCircuits(1_000_000)[0]).toMatchObject({ model: "alpha/one", category: "quota" });
  });

  it("writes atomically and leaves no temporary files behind", () => {
    const path = join(dir, "health.json");
    const store = new HealthStore({ path, config: CONFIG });
    store.recordFailure("alpha/one", "quota", 1_000);
    store.recordFailure("alpha/two", "auth", 1_000);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });

  it("fails open on missing, corrupt or version-mismatched state", () => {
    expect(loadHealthState(join(dir, "missing.json")).models).toEqual({});
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json", "utf8");
    expect(loadHealthState(corrupt).models).toEqual({});
    const wrongVersion = join(dir, "wrong.json");
    writeFileSync(wrongVersion, JSON.stringify({ version: 2, models: { "a/b": { failures: [1] } } }), "utf8");
    expect(loadHealthState(wrongVersion).models).toEqual({});
  });

  it("drops malformed records and fields instead of crashing", () => {
    const path = join(dir, "mixed.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      models: {
        "good/one": { failures: [1_000, "bad", Number.NaN, Number.POSITIVE_INFINITY], openUntil: 2_000, trialActive: "yes", lastFailureCategory: "quota" },
        "bad/one": "nonsense",
        "list/one": [],
      },
    }), "utf8");
    const state = loadHealthState(path);
    expect(state.models["good/one"]!.failures).toEqual([1_000]);
    expect(state.models["good/one"]!.openUntil).toBe(2_000);
    expect(state.models["good/one"]!.trialActive).toBeUndefined();
    expect(state.models["good/one"]!.lastFailureCategory).toBe("quota");
    expect(state.models["bad/one"]).toBeUndefined();
    expect(state.models["list/one"]).toBeUndefined();
  });

  it("reloads state written by another instance", () => {
    const path = join(dir, "health.json");
    const first = new HealthStore({ path, config: CONFIG });
    first.recordFailure("alpha/one", "quota", 1_000);
    const second = new HealthStore({ path, config: CONFIG, now: () => 1_000 });
    expect(second.circuit("alpha/one").open).toBe(true);
  });

  it("is a no-op while disabled", () => {
    const path = join(dir, "health.json");
    const store = new HealthStore({ path, config: { ...CONFIG, enabled: false } });
    store.recordFailure("alpha/one", "quota", 1_000);
    expect(store.getState().models).toEqual({});
    expect(store.openCircuitCount(1_000)).toBe(0);
    expect(store.tryClaimTrial("alpha/one", 1_000)).toEqual({ allowed: true, claimed: false });
  });

  it("uses an in-memory io seam so tests never touch real agent state", () => {
    const { io, read } = memoryIo();
    const store = new HealthStore({ io, config: CONFIG, now: () => 5_000 });
    store.recordFailure("alpha/one", "network", 5_000);
    expect(read()!.models["alpha/one"]!.failures).toEqual([5_000]);
  });
});

describe("health store trial ownership", () => {
  it("allows a single half-open trial and releases it on abandon", () => {
    const { io, read } = memoryIo();
    let now = 1_000_000;
    const store = new HealthStore({ io, config: { ...CONFIG, failureThreshold: 1 }, now: () => now });
    store.recordFailure("alpha/one", "quota", now);
    const openUntil = store.circuit("alpha/one", now).openUntil!;

    now = openUntil + 1;
    expect(store.tryClaimTrial("alpha/one", now)).toEqual({ allowed: true, claimed: true });
    expect(store.tryClaimTrial("alpha/one", now)).toEqual({ allowed: false, claimed: false });
    expect(read()!.models["alpha/one"]!.trialActive).toBe(true);

    store.abandonTrial("alpha/one");
    expect(store.circuit("alpha/one", now).halfOpen).toBe(true);
    expect(store.tryClaimTrial("alpha/one", now)).toEqual({ allowed: true, claimed: true });
  });

  it("clears a stranded claim left behind by a killed process", () => {
    // The state a crash leaves: half-open, claim still set, no stamp to age it.
    // Every dispatch would refuse this model with `trial-in-progress`, and the
    // open-circuit count reports nothing wrong.
    const { io, read } = memoryIo();
    let now = 1_000_000;
    const store = new HealthStore({ io, config: { ...CONFIG, failureThreshold: 1 }, now: () => now });
    store.recordFailure("alpha/one", "quota", now);
    const openUntil = store.circuit("alpha/one", now).openUntil!;
    now = openUntil + 1;
    store.tryClaimTrial("alpha/one", now);

    // Simulate the crash: the claim survives, the process that owns it does not.
    const stranded = { ...read()!, models: { "alpha/one": { ...read()!.models["alpha/one"]!, trialClaimedAt: undefined } } };
    const reopened = new HealthStore({ io: { ...io, load: () => structuredClone(stranded) }, config: { ...CONFIG, failureThreshold: 1 }, now: () => now });

    expect(reopened.circuit("alpha/one", now).trialActive).toBe(false);
    expect(reopened.tryClaimTrial("alpha/one", now)).toEqual({ allowed: true, claimed: true });
  });

  it("reports a stale claim under status and clears it from disk", () => {
    const { io, read } = memoryIo();
    let now = 1_000_000;
    const store = new HealthStore({ io, config: { ...CONFIG, failureThreshold: 1 }, now: () => now });
    store.recordFailure("alpha/one", "quota", now);
    const openUntil = store.circuit("alpha/one", now).openUntil!;
    now = openUntil + 1;
    store.tryClaimTrial("alpha/one", now);

    const stranded = { ...read()!, models: { "alpha/one": { ...read()!.models["alpha/one"]!, trialClaimedAt: undefined } } };
    const reopened = new HealthStore({ io: { ...io, load: () => structuredClone(stranded) }, config: { ...CONFIG, failureThreshold: 1 }, now: () => now });

    const summary = reopened.openCircuits(now);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ model: "alpha/one", trialExpired: true, trialActive: false });
    // The dead claim is gone from the persisted state, not just hidden.
    expect(reopened.getState().models["alpha/one"]!.trialActive).toBeUndefined();
  });

  it("closes a half-open circuit after a successful trial", () => {
    const { io } = memoryIo();
    let now = 100;
    const store = new HealthStore({ io, config: { ...CONFIG, failureThreshold: 1 }, now: () => now });
    store.recordFailure("alpha/one", "quota", 100);
    now = store.circuit("alpha/one", 100).openUntil! + 1;
    store.tryClaimTrial("alpha/one", now);
    store.recordSuccess("alpha/one", now);
    expect(store.circuit("alpha/one", now).open).toBe(false);
    expect(store.circuit("alpha/one", now).halfOpen).toBe(false);
  });

  it("reports open circuits with sanitized model/category/cooldown facts", () => {
    const path = join(dir, "health.json");
    const store = new HealthStore({ path, config: { ...CONFIG, failureThreshold: 1 } });
    store.recordFailure("alpha/one", "auth", 1_000);
    const summary = store.openCircuits(1_000);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.model).toBe("alpha/one");
    expect(summary[0]!.category).toBe("auth");
    expect(Date.parse(summary[0]!.openUntil!)).toBeGreaterThan(1_000);
    expect(store.openCircuitCount(1_000)).toBe(1);
  });
});

describe("health state save/load helpers", () => {
  it("normalizes on save and load", () => {
    const path = join(dir, "direct.json");
    const state = emptyHealthState();
    state.models["m/one"] = { failures: [1], openUntil: 2, trialActive: true };
    saveHealthState(path, state);
    expect(loadHealthState(path).models["m/one"]).toMatchObject({ failures: [1], openUntil: 2, trialActive: true });
  });
});
