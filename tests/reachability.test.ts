import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROBE_CACHE_VERSION,
  categorizeProbeError,
  isKnownUnreachable,
  isProbeCacheFresh,
  readProbeCache,
  runProbe,
  writeProbeCache,
  type ProbeCache,
} from "../src/reachability.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delegateau-probe-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("categorizeProbeError", () => {
  // The failure that motivated this module: a listed, auth-configured model that
  // the API nonetheless refuses.
  it("classifies the ChatGPT-account rejection as an unsupported model", () => {
    expect(categorizeProbeError("The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."))
      .toBe("unsupported-model");
  });

  it("classifies a free-tier refusal as unsupported", () => {
    expect(categorizeProbeError("OpenCode's free tier can only be used from within OpenCode")).toBe("unsupported-model");
  });

  it("classifies auth, quota, timeout and network failures", () => {
    expect(categorizeProbeError("401 Cannot authenticate with the server")).toBe("auth");
    expect(categorizeProbeError("no api key configured")).toBe("auth");
    expect(categorizeProbeError("429 rate limit exceeded")).toBe("quota");
    expect(categorizeProbeError("Request timed out after 100ms.")).toBe("timeout");
    expect(categorizeProbeError("fetch failed: ENOTFOUND api.example")).toBe("network");
  });

  // Raw provider text must never reach disk, so an unrecognised body collapses
  // to a stable category rather than being persisted.
  it("collapses unrecognised provider text to a stable category", () => {
    expect(categorizeProbeError("some brand new provider failure with an echoed prompt body"))
      .toBe("unknown-error");
  });
});

describe("probe cache", () => {
  const cache = (probedAt: string, reachable: boolean): ProbeCache => ({
    version: PROBE_CACHE_VERSION,
    probedAt,
    results: [{ identity: { provider: "openai-codex", id: "gpt-5.4-mini" }, reachable, errorCategory: reachable ? undefined : "unsupported-model", probedAt }],
  });

  it("round-trips through disk", () => {
    const path = join(dir, "reachability.json");
    const written = cache(new Date().toISOString(), false);
    writeProbeCache(written, path);
    expect(readProbeCache(path)).toMatchObject({ version: PROBE_CACHE_VERSION });
    expect(readProbeCache(path)!.results[0]!.reachable).toBe(false);
  });

  it("treats a missing or malformed cache as absent rather than throwing", () => {
    expect(readProbeCache(join(dir, "nope.json"))).toBeUndefined();
    const bad = join(dir, "bad.json");
    writeProbeCache({ version: 99 as unknown as 1, probedAt: "x", results: [] }, bad);
    expect(readProbeCache(bad)).toBeUndefined();
  });

  // One probe per day, not per session: freshness is what keeps the probe off
  // the dispatch path and out of the quota.
  it("considers a cache fresh for 24h and stale after", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(isProbeCacheFresh(cache("2026-09-19T11:00:00Z", true), now)).toBe(true);
    expect(isProbeCacheFresh(cache("2026-09-18T11:00:00Z", true), now)).toBe(false);
    expect(isProbeCacheFresh(undefined, now)).toBe(false);
    expect(isProbeCacheFresh(cache("not-a-date", true), now)).toBe(false);
  });

  it("reports a probed-unreachable model as excluded", () => {
    expect(isKnownUnreachable({ provider: "openai-codex", id: "gpt-5.4-mini" }, cache(new Date().toISOString(), false))).toBe(true);
    expect(isKnownUnreachable({ provider: "openai-codex", id: "gpt-5.4-mini" }, cache(new Date().toISOString(), true))).toBe(false);
  });

  // The whole point of the earlier bug: an unprobed model must NOT be treated as
  // dead, or the pool silently shrinks — which is how gpt-6-astra went missing.
  it("treats an unprobed model as reachable rather than excluding it", () => {
    expect(isKnownUnreachable({ provider: "openai-codex", id: "gpt-6-astra" }, cache(new Date().toISOString(), false))).toBe(false);
    expect(isKnownUnreachable({ provider: "openai-codex", id: "gpt-6-astra" }, undefined)).toBe(false);
  });

  it("keeps explicit setup probes online while background probes can remain offline", async () => {
    const command = join(dir, "fake-pi");
    writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args\"\nprintf 'OK\\n'\n", "utf8");
    chmodSync(command, 0o755);
    const target = { provider: "fake", id: "live" };
    await runProbe({ command, cwd: dir, targets: [target] });
    expect(readFileSync(join(dir, "args"), "utf8")).not.toContain("--offline");
    await runProbe({ command, cwd: dir, targets: [target], offline: true });
    expect(readFileSync(join(dir, "args"), "utf8")).toContain("--offline");
  });
});

describe("per-result reachability freshness", () => {
  const now = Date.parse("2026-09-19T12:00:00Z");
  const target = { provider: "openai-codex", id: "gpt-5.4-mini" };

  /** A negative result whose own timestamp may differ from the file's. */
  const negative = (resultProbedAt: string, cacheProbedAt = "2026-09-19T12:00:00Z"): ProbeCache => ({
    version: PROBE_CACHE_VERSION,
    probedAt: cacheProbedAt,
    results: [{ identity: target, reachable: false, errorCategory: "unsupported-model", probedAt: resultProbedAt }],
  });

  const positive = (probedAt: string): ProbeCache => ({
    version: PROBE_CACHE_VERSION,
    probedAt,
    results: [{ identity: target, reachable: true, probedAt }],
  });

  it("excludes a model whose negative result is fresh", () => {
    expect(isKnownUnreachable(target, negative("2026-09-19T11:00:00Z"), now)).toBe(true);
  });

  // The stale-probe bug: a merged cache keeps an old negative entry while the
  // top-level file stamp stays fresh. Only the entry's own age may exclude.
  it("treats a negative result older than 24h as unprobed even while the cache file remains", () => {
    const stale = negative("2026-09-18T11:59:59Z", "2026-09-19T12:00:00Z");
    expect(isProbeCacheFresh(stale, now)).toBe(true);
    expect(isKnownUnreachable(target, stale, now)).toBe(false);
  });

  it("treats a negative result exactly at the 24h boundary as stale", () => {
    expect(isKnownUnreachable(target, negative("2026-09-18T12:00:00Z"), now)).toBe(false);
  });

  // A negative result dated after the injected clock is not fresh evidence; it
  // is invalid and must be treated as unprobed so a skewed timestamp cannot
  // exclude the model indefinitely into the future.
  it("treats a negative result dated after the current time as unprobed", () => {
    expect(isKnownUnreachable(target, negative("2026-09-19T12:00:01Z"), now)).toBe(false);
  });

  it("does not exclude when the per-result timestamp is missing", () => {
    const cache = {
      version: PROBE_CACHE_VERSION,
      probedAt: "2026-09-19T11:00:00Z",
      results: [{ identity: target, reachable: false, probedAt: undefined as unknown as string }],
    } as ProbeCache;
    expect(isKnownUnreachable(target, cache, now)).toBe(false);
  });

  it("does not exclude when the per-result timestamp is malformed", () => {
    expect(isKnownUnreachable(target, negative("not-a-date"), now)).toBe(false);
  });

  it("never excludes a reachable model, fresh or stale", () => {
    expect(isKnownUnreachable(target, positive("2026-09-19T11:00:00Z"), now)).toBe(false);
    expect(isKnownUnreachable(target, positive("2026-09-01T11:00:00Z"), now)).toBe(false);
  });

  it("judges each result by its own timestamp, not the newest file write", () => {
    const mixed: ProbeCache = {
      version: PROBE_CACHE_VERSION,
      probedAt: "2026-09-19T11:00:00Z",
      results: [
        { identity: { provider: "openai-codex", id: "stale-negative" }, reachable: false, probedAt: "2026-09-17T11:00:00Z" },
        { identity: { provider: "openai-codex", id: "fresh-negative" }, reachable: false, probedAt: "2026-09-19T11:00:00Z" },
      ],
    };
    expect(isKnownUnreachable({ provider: "openai-codex", id: "stale-negative" }, mixed, now)).toBe(false);
    expect(isKnownUnreachable({ provider: "openai-codex", id: "fresh-negative" }, mixed, now)).toBe(true);
  });
});
