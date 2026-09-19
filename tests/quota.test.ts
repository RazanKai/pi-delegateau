import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeCostSignal,
  measurementKey,
  quotaUnitsFor,
  readQuotaStore,
  resolveCostMode,
  resolveCostSignal,
  writeQuotaStore,
  type QuotaStore,
} from "../src/quota.js";

/** Real response shape from the grandfathered plan: zero cost, active buckets. */
const GPU_TIME_USAGE = { activity: { cost: "0.00000", period: { type: "last_4_weeks" } }, limits: { session: { usage: 0.07 }, weekly: { usage: 0.95 } } };
/** A credit-based plan would show real dollar spend. */
const CREDIT_USAGE = { activity: { cost: "28.87", period: { type: "last_4_weeks" } }, limits: { session: { usage: 0.07 } } };

const store: QuotaStore = {
  version: 1,
  baselineModel: "deepseek-v4.1-flash",
  measurements: [
    { model: "deepseek-v4.1-flash", provider: "ollama-cloud", unitsPerCall: 1, source: "measured", measuredAt: "2026-09-19T00:00:00Z", samples: 20 },
    { model: "glm-5.3-flash", provider: "ollama-cloud", unitsPerCall: 3.5, source: "user-reported", measuredAt: "2026-09-19T00:00:00Z" },
  ],
};

describe("resolveCostMode — how the account is set up decides the axis", () => {
  // The central case. Both Ollama plans authenticate with an api_key, so auth
  // shape CANNOT tell them apart — the account's own telemetry is the only
  // reliable discriminator, and plan detection outranks it.
  it("detects the grandfathered plan from zero-cost account data", () => {
    const r = resolveCostMode("ollama-cloud", {}, "api_key", GPU_TIME_USAGE);
    expect(r.decidedBy).toBe("detected-plan");
    expect(r.mode).toBe("quota-gpu-time");
    expect(r.note).toContain("GPU time");
  });

  it("detects a credit-based plan from non-zero account spend", () => {
    const r = resolveCostMode("ollama-cloud", {}, "api_key", CREDIT_USAGE);
    expect(r.decidedBy).toBe("detected-plan");
    expect(r.mode).toBe("token");
  });

  it("stays undecided when the account cannot be read", () => {
    const r = resolveCostMode("ollama-cloud", {}, "api_key", null);
    expect(r.decidedBy).toBe("detected-api-key");
    expect(r.mode).toBe("token");
  });

  // The user's point: an Ollama subscription on the NEW plan is credit-based, so
  // price tracks consumption directly and the token axis is correct.
  it("treats the credit-based Ollama plan as per-token", () => {
    const r = resolveCostMode("ollama-cloud", { ollamaPlan: "credits" });
    expect(r.mode).toBe("token");
    expect(r.note).toContain("credit-based");
  });

  it("honours an explicit plan over detection", () => {
    const forced = resolveCostMode("ollama-cloud", { ollamaPlan: "gpu-time" }, "api_key", CREDIT_USAGE);
    expect(forced.mode).toBe("quota-gpu-time");
    expect(forced.decidedBy).toBe("config-override");
  });

  // The other case the user raised: OpenAI through API credits rather than a sub.
  it("treats an OpenAI API key as per-token, not quota", () => {
    const r = resolveCostMode("openai-codex", {}, "api_key");
    expect(r.mode).toBe("token");
    expect(r.decidedBy).toBe("detected-api-key");
  });

  it("treats an OpenAI subscription as per-token because it meters tokens", () => {
    const r = resolveCostMode("openai-codex", {}, "oauth");
    expect(r.mode).toBe("token");
    expect(r.decidedBy).toBe("detected-subscription");
  });

  it("falls back to per-token when no credential exists yet", () => {
    const r = resolveCostMode("a-provider-added-later", {}, undefined);
    expect(r.mode).toBe("token");
    expect(r.decidedBy).toBe("default");
  });

  it("lets explicit config override detection", () => {
    const r = resolveCostMode("ollama-cloud", { providers: { "ollama-cloud": "token" } }, "oauth");
    expect(r.mode).toBe("token");
    expect(r.decidedBy).toBe("config-override");
  });
});

describe("measurementKey", () => {
  it("strips a dated tag, which is a documented alias to the same model", () => {
    expect(measurementKey("deepseek-v4-flash:0731")).toBe("deepseek-v4-flash");
  });

  // Architecture decides GPU-time cost, so siblings must NOT share a measurement.
  it("keeps qualifier suffixes distinct", () => {
    expect(measurementKey("glm-5.3-flash")).toBe("glm-5.3-flash");
    expect(measurementKey("glm-5.3")).toBe("glm-5.3");
  });
});

describe("resolveCostSignal — price is always present, quota is an overlay", () => {
  // The user's correction: API price remains a good general trendline, so it must
  // not be dropped even on a quota-metered provider.
  it("keeps the price trendline on a quota provider and adds the measured multiplier", () => {
    const s = resolveCostSignal(
      { provider: "ollama-cloud", id: "glm-5.3-flash" },
      { cost: { input: 0.15, output: 0.5 }, costSource: "provider" },
      { quotaStore: store, authType: "api_key", ollamaUsage: GPU_TIME_USAGE },
    );
    expect(s.mode).toBe("quota-gpu-time");
    expect(s.price).toEqual({ input: 0.15, output: 0.5 });
    expect(s.quotaUnits).toBe(3.5);
    const text = describeCostSignal(s);
    expect(text).toContain("3.5x");
    expect(text).toContain("trendline");
  });

  it("says the price is only a rough trendline when quota is unmeasured", () => {
    const s = resolveCostSignal(
      { provider: "ollama-cloud", id: "kimi-k3" },
      { cost: { input: 3, output: 15 }, costSource: "provider" },
      { quotaStore: store, authType: "api_key", ollamaUsage: GPU_TIME_USAGE },
    );
    expect(s.quotaUnmeasured).toBe(true);
    expect(s.price).toEqual({ input: 3, output: 15 });
    const text = describeCostSignal(s);
    expect(text).toContain("rough trendline");
    expect(text).toContain("$3/M in");
  });

  // On a token-metered provider price IS the axis, so no multiplier applies.
  it("reports plain per-token pricing on a token provider", () => {
    const s = resolveCostSignal(
      { provider: "openai-codex", id: "gpt-5.6-luna" },
      { cost: { input: 0.2, output: 1.2 }, costSource: "provider" },
      { quotaStore: store, authType: "api_key", ollamaUsage: GPU_TIME_USAGE },
    );
    expect(s.mode).toBe("token");
    expect(s.quotaUnits).toBeUndefined();
    expect(describeCostSignal(s)).toBe("$0.2/M in, $1.2/M out (per-token billing)");
  });

  // The user's scenario: added the extension first, provider set up later. A later
  // session re-detects and switches axis with no reinstall.
  it("switches axis when a provider is configured after install", () => {
    // No credential yet: the `default` branch is what an unconfigured provider hits.
    const fresh = resolveCostMode("a-brand-new-provider", {}, undefined);
    expect(fresh.decidedBy).toBe("default");
    expect(fresh.mode).toBe("token");

    // Same provider once an API key exists.
    const keyed = resolveCostMode("a-brand-new-provider", {}, "api_key");
    expect(keyed.decidedBy).toBe("detected-api-key");
    expect(keyed.mode).toBe("token");

    // And if it turns out to be a GPU-time subscription instead.
    const subbed = resolveCostSignal(
      { provider: "ollama-cloud", id: "glm-5.3-flash" },
      { cost: { input: 0.15, output: 0.5 }, costSource: "provider" },
      { quotaStore: store, authType: "api_key", ollamaUsage: GPU_TIME_USAGE },
    );
    expect(subbed.mode).toBe("quota-gpu-time");
  });
});

describe("quota store persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delegateau-quota-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips", () => {
    const p = join(dir, "quota.json");
    writeQuotaStore(store, p);
    expect(readQuotaStore(p)?.measurements).toHaveLength(2);
  });

  it("treats a malformed store as absent rather than throwing", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, '{"version":99}');
    expect(readQuotaStore(p)).toBeUndefined();
    expect(readQuotaStore(join(dir, "missing.json"))).toBeUndefined();
  });

  it("matches only the measured variant, never a sibling", () => {
    expect(quotaUnitsFor({ provider: "ollama-cloud", id: "glm-5.3-flash" }, store)?.units).toBe(3.5);
    expect(quotaUnitsFor({ provider: "ollama-cloud", id: "glm-5.3" }, store)).toBeUndefined();
  });
});
