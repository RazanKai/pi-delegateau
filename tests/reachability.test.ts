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
