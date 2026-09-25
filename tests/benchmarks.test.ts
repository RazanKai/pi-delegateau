import { describe, expect, it, vi } from "vitest";
import {
  collectBenchmarkEvidence,
  importBenchmarkFile,
  mergeBenchmarkReport,
  normalizeBenchmarkDocument,
  type BenchmarkCache,
} from "../src/benchmarks.js";
import type { BenchmarkEvidence } from "../src/types.js";
import { parseConfig } from "../src/config.js";

const knownModels = [
  { provider: "alpha", id: "model-a" },
  { provider: "beta", id: "model-b" },
];

function record(model = knownModels[0]!, metric = "coding-average", score = 72.5): BenchmarkEvidence {
  return {
    model,
    source: "livebench-official",
    sourceUrl: "https://livebench.github.io/",
    benchmark: "LiveBench",
    version: "2026-01-08",
    metric,
    date: "2026-01-08",
    dateKind: "source-reported",
    provenance: "independent",
    score,
    unit: "percent",
    direction: "higher-is-better",
  };
}

describe("benchmark evidence import and config boundary", () => {
  it("normalizes bounded multi-record evidence and keeps ignored input visible without promoting it", () => {
    const raw = {
      version: 1,
      records: [
        record(),
        record(knownModels[0], "agentic-coding-average", 61),
        record({ provider: "unknown", id: "model" }, "coding-average", 99),
        { ...record(knownModels[1]), date: "2020-01-01" },
        { ...record(knownModels[1]), score: Number.NaN },
        { ...record(knownModels[1]), sourceUrl: "https://example.test/path?api_key=SECRET" },
      ],
    };
    const report = normalizeBenchmarkDocument(raw, {
      knownModels,
      now: new Date("2026-09-21T00:00:00.000Z"),
    });

    expect(report.records).toHaveLength(2);
    expect(report.records.map((entry) => entry.metric)).toEqual(["coding-average", "agentic-coding-average"]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual([
      "unmatched-model",
      "stale",
      "malformed",
      "unsafe-source-url",
    ]);
    expect(JSON.stringify(report)).not.toContain("SECRET");

    const parsed = parseConfig({ candidates: [{ ...knownModels[0], benchmarks: report.records }] });
    expect(parsed.candidates[0]!.benchmarks).toEqual(report.records);
  });

  it("imports a local document without a network seam and atomically merges cache records", async () => {
    const existing: BenchmarkCache = {
      version: 1,
      updatedAt: "2026-09-20T00:00:00.000Z",
      records: [record(knownModels[0], "global-average", 70)],
      diagnostics: [],
    };
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ version: 1, records: [record()] }));
    const readCache = vi.fn().mockResolvedValue(existing);
    const writeCache = vi.fn().mockResolvedValue(undefined);

    const result = await importBenchmarkFile("/explicit/evidence.json", {
      knownModels,
      now: new Date("2026-09-21T00:00:00.000Z"),
      readFile,
      readCache,
      writeCache,
    });

    expect(readFile).toHaveBeenCalledWith("/explicit/evidence.json");
    expect(writeCache).toHaveBeenCalledOnce();
    const written = writeCache.mock.calls[0]![0] as BenchmarkCache;
    // Freshly imported records come first: the per-model cap must be able to
    // evict older evidence, never the record the user just asked to import.
    expect(written.records.map((entry) => entry.metric)).toEqual(["coding-average", "global-average"]);
    expect(result.imported).toBe(1);
    expect(result.retained).toBe(1);
    expect(result.dropped).toBe(0);
  });

  it("retains a fresh import that would otherwise be crowded out by the per-model cap", async () => {
    // The imported record is the 9th for this model, one past the cap of 8.
    // Adding prior records first dropped it while still reporting success.
    const prior: BenchmarkCache = {
      version: 1,
      updatedAt: "2026-09-20T00:00:00.000Z",
      records: Array.from({ length: 8 }, (_value, index) => record(knownModels[0], `prior-${index}`, 50 + index)),
      diagnostics: [],
    };
    const fresh: BenchmarkEvidence = record(knownModels[0], "fresh-metric", 99);
    const result = await importBenchmarkFile("/explicit/fresh.json", {
      knownModels,
      now: new Date("2026-09-21T00:00:00.000Z"),
      readFile: vi.fn().mockResolvedValue(JSON.stringify({ version: 1, records: [fresh] })),
      readCache: vi.fn().mockResolvedValue(prior),
      writeCache: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.imported).toBe(1);
    expect(result.retained).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.records.map((entry) => entry.metric)).toContain("fresh-metric");
    expect(result.records).toHaveLength(8);
    // The eviction is reported rather than silent.
    expect(result.records.map((entry) => entry.metric)).not.toContain("prior-7");
  });

  it("rejects malformed benchmark records embedded directly in policy config", () => {
    expect(() => parseConfig({ candidates: [{ ...knownModels[0], benchmarks: [{ ...record(), sourceUrl: "http://not-https.test" }] }] })).toThrow(/benchmarks/);
    expect(() => parseConfig({ candidates: [{ ...knownModels[0], benchmarks: Array.from({ length: 9 }, () => record()) }] })).toThrow(/at most/);
  });

  it("applies the documented age rule to records embedded in config", () => {
    const now = new Date("2026-09-21T00:00:00.000Z").getTime();
    // The setup help and README advertise a 730-day rule; a hand-written config
    // must not be able to bypass it.
    expect(() => parseConfig({ candidates: [{ ...knownModels[0], benchmarks: [{ ...record(), date: "2001-01-01" }] }] }, now)).toThrow(/older than 730 days/);
    expect(() => parseConfig({ candidates: [{ ...knownModels[0], benchmarks: [{ ...record(), date: "2099-12-31" }] }] }, now)).toThrow(/future/);
    // A record inside the window still parses.
    const ok = parseConfig({ candidates: [{ ...knownModels[0], benchmarks: [{ ...record(), date: "2026-01-08" }] }] }, now);
    expect(ok.candidates[0]!.benchmarks).toHaveLength(1);
  });

  it("ignores untrusted provenance without echoing the rejected value", () => {
    const raw = {
      version: 1,
      records: [
        { ...record(), provenance: "vendor" },
        { ...record(knownModels[0], "kept", 60), provenance: "independent" },
      ],
    };
    const report = normalizeBenchmarkDocument(raw, { knownModels, now: new Date("2026-09-21T00:00:00.000Z") });
    expect(report.records.map((entry) => entry.metric)).toEqual(["kept"]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["malformed"]);
    expect(JSON.stringify(report)).not.toContain("vendor");
  });

  it("collects the exact offered records once, preserving unlike metrics and capping the list", () => {
    const candidates = [
      { identity: knownModels[0]!, description: "a", capabilities: [], provenance: "user" as const, benchmarks: [record(knownModels[0], "one", 1), record(knownModels[0], "two", 2)] },
      { identity: knownModels[1]!, description: "b", capabilities: [], provenance: "user" as const, benchmarks: [record(knownModels[0], "one", 1)] },
    ];
    const collected = collectBenchmarkEvidence(candidates);
    expect(collected.map((entry) => entry.metric)).toEqual(["one", "two"]);
    expect(collectBenchmarkEvidence(candidates, 1)).toHaveLength(1);
  });

  it("merges acquisition reports without collapsing unlike records", () => {
    const prior: BenchmarkCache = { version: 1, updatedAt: "2026-09-20T00:00:00.000Z", records: [record(knownModels[0], "global-average", 70)], diagnostics: [] };
    const merged = mergeBenchmarkReport(prior, { records: [record(knownModels[0], "coding-average", 72.5)], diagnostics: [{ category: "stale" }] }, { knownModels, now: new Date("2026-09-21T00:00:00.000Z") });
    expect(merged.records.map((entry) => entry.metric)).toEqual(["coding-average", "global-average"]);
    expect(merged.diagnostics.map((entry) => entry.category)).toEqual(["stale"]);
  });

  it("does not accumulate duplicate diagnostics across repeated merges", () => {
    const prior: BenchmarkCache = {
      version: 1,
      updatedAt: "2026-09-20T00:00:00.000Z",
      records: [record(knownModels[0], "coding-average", 60)],
      diagnostics: [{ category: "stale" }, { category: "stale" }],
    };
    const stale = { ...record(knownModels[0], "coding-average", 60), date: "2020-01-01" };
    const first: BenchmarkCache = mergeBenchmarkReport(prior, { records: [stale], diagnostics: [] }, { knownModels, now: new Date("2026-09-21T00:00:00.000Z") });
    const second: BenchmarkCache = mergeBenchmarkReport(first, { records: [stale], diagnostics: [] }, { knownModels, now: new Date("2026-09-21T00:00:00.000Z") });
    // The stale record is diagnosed once, not once per merge.
    expect(second.diagnostics.map((entry) => entry.category)).toEqual(["stale"]);
  });

  it("preserves distinct observations that share a comparison key but differ in date or score", () => {
    const raw = {
      version: 1,
      records: [
        record(knownModels[0], "coding-average", 60),
        { ...record(knownModels[0], "coding-average", 60), date: "2026-02-08" },
        { ...record(knownModels[0], "coding-average", 75) },
      ],
    };
    const report = normalizeBenchmarkDocument(raw, { knownModels, now: new Date("2026-09-21T00:00:00.000Z") });
    expect(report.records).toHaveLength(3);
    expect(report.records.map((entry) => entry.score)).toEqual([60, 60, 75]);
  });

  it("revalidates prior cache records before merging so stale records cannot crowd out fresh evidence", () => {
    const stale = Array.from({ length: 8 }, (_, index) => ({ ...record(knownModels[0], `stale-${index}`, index), date: "2020-01-01" }));
    const prior: BenchmarkCache = { version: 1, updatedAt: "2020-01-01T00:00:00.000Z", records: stale, diagnostics: [] };
    const merged = mergeBenchmarkReport(prior, { records: [record(knownModels[0], "fresh", 99)], diagnostics: [] }, { knownModels, now: new Date("2026-09-21T00:00:00.000Z") });
    expect(merged.records.map((entry) => entry.metric)).toContain("fresh");
    expect(merged.records).toHaveLength(1);
  });
});
