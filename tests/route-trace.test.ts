import { describe, expect, it } from "vitest";
import { MAX_TRACE_BENCHMARKS, MAX_TRACE_LIST, buildRouteTrace, mergeExcludedCandidates } from "../src/route-trace.js";
import { buildReceipt } from "../src/receipts.js";

describe("route trace", () => {
  it("captures the selection decision and derives stable filter facts", () => {
    const trace = buildRouteTrace({
      dispatchId: "d-1",
      decisionId: "req-1",
      agent: "worker",
      startedAt: "2026-09-21T00:00:00.000Z",
      endedAt: "2026-09-21T00:00:01.000Z",
      candidateIds: ["alpha/fast", "beta/solid"],
      excluded: [
        { id: "gamma/open", reasons: ["circuit-open"], openUntil: "2026-09-21T01:00:00.000Z" },
        { id: "delta/dry", reasons: ["quota-exhausted"] },
        { id: "epsilon/old", reasons: ["unreachable"] },
      ],
      selectionSource: "jev",
      selectedModel: "alpha/fast",
      appliedModel: "alpha/fast",
      servedModel: "alpha/fast",
      jev: { latencyMs: 812, confidence: 0.72, probabilities: { "alpha/fast": 0.6, "beta/solid": 0.4 } },
      outcome: "success",
    });
    expect(trace).toMatchObject({
      version: 1,
      dispatchId: "d-1",
      decisionId: "req-1",
      selectionSource: "jev",
      selectedModel: "alpha/fast",
      outcome: "success",
    });
    expect(trace.filters.circuitOpen).toEqual(["gamma/open"]);
    expect(trace.filters.quotaExcluded).toEqual(["delta/dry"]);
    expect(trace.filters.unreachable).toEqual(["epsilon/old"]);
    expect(trace.excluded.find((entry) => entry.id === "gamma/open")!.openUntil).toBe("2026-09-21T01:00:00.000Z");
    expect(trace.jev).toMatchObject({ latencyMs: 812, confidence: 0.72 });
    expect(trace.errorCategory).toBeUndefined();
  });

  it("records the exact bounded benchmark facts offered to Jev", () => {
    const benchmark = {
      model: { provider: "alpha", id: "fast" },
      source: "livebench-official",
      sourceUrl: "https://livebench.github.io/",
      benchmark: "LiveBench",
      version: "2026-01-08",
      metric: "coding-average",
      date: "2026-01-08",
      dateKind: "source-reported" as const,
      provenance: "independent" as const,
      score: 72.5,
      unit: "percent",
      direction: "higher-is-better" as const,
    };
    const trace = buildRouteTrace({
      dispatchId: "d-bench",
      agent: "worker",
      startedAt: "a",
      endedAt: "b",
      candidateIds: ["alpha/fast"],
      excluded: [],
      selectionSource: "jev",
      benchmarkEvidence: [benchmark],
      benchmarksOfferedToJev: true,
      outcome: "success",
    });
    expect(trace.benchmarks).toEqual({ offeredToJev: true, records: [benchmark], offeredCount: 1, truncated: false });
    expect(JSON.stringify(trace.benchmarks)).not.toContain("task");
  });

  it("marks the record list truncated instead of silently dropping records", () => {
    // The chooser has no cap of its own, so a trace reader must be able to tell
    // a complete record list from a clipped one.
    const records = Array.from({ length: MAX_TRACE_BENCHMARKS + 5 }, (_value, index) => ({
      model: { provider: "alpha", id: "fast" },
      source: "LiveBench",
      sourceUrl: "https://livebench.github.io/",
      benchmark: "LiveBench",
      version: `2026-01-${String(index).padStart(2, "0")}`,
      metric: `metric-${index}`,
      date: "2026-01-08",
      dateKind: "source-reported" as const,
      provenance: "independent" as const,
      score: 70 + index,
      unit: "percent",
      direction: "higher-is-better" as const,
    }));
    const trace = buildRouteTrace({
      dispatchId: "d-cap",
      agent: "worker",
      startedAt: "a",
      endedAt: "b",
      candidateIds: ["alpha/fast"],
      excluded: [],
      selectionSource: "jev",
      benchmarkEvidence: records,
      benchmarksOfferedToJev: true,
      outcome: "success",
    });
    expect(trace.benchmarks?.offeredCount).toBe(records.length);
    expect(trace.benchmarks?.truncated).toBe(true);
    expect(trace.benchmarks?.records).toHaveLength(MAX_TRACE_BENCHMARKS);
  });

  it("records a failure category without raw provider text", () => {
    const trace = buildRouteTrace({
      dispatchId: "d-2",
      agent: "worker",
      startedAt: "a",
      endedAt: "b",
      candidateIds: ["alpha/fast"],
      excluded: [],
      selectionSource: "fixed",
      selectedModel: "alpha/fast",
      appliedModel: "omega/served",
      servedModel: "omega/served",
      outcome: "failed",
      errorCategory: "quota",
    });
    expect(trace.errorCategory).toBe("quota");
    expect(trace.appliedModel).toBe("omega/served");
    expect(JSON.stringify(trace)).not.toContain("429");
  });

  it("unions repeated exclusions for the same candidate", () => {
    const merged = mergeExcludedCandidates(
      [{ id: "a/b", reasons: ["circuit-open"], openUntil: "t1" }],
      [{ id: "a/b", reasons: ["trial-active"] }, { id: "c/d", reasons: ["no-auth"] }],
    );
    expect(merged).toEqual([
      { id: "a/b", reasons: ["circuit-open", "trial-active"], openUntil: "t1" },
      { id: "c/d", reasons: ["no-auth"] },
    ]);
  });

  it("bounds candidate and probability lists", () => {
    const candidateIds = Array.from({ length: MAX_TRACE_LIST + 50 }, (_, index) => `p/m-${index}`);
    const probabilities = Object.fromEntries(candidateIds.map((id) => [id, 1]));
    const trace = buildRouteTrace({
      dispatchId: "d-3",
      agent: "worker",
      startedAt: "a",
      endedAt: "b",
      candidateIds,
      excluded: candidateIds.map((id) => ({ id, reasons: ["quota-exhausted"] as const })),
      selectionSource: "jev",
      jev: { probabilities },
      outcome: "success",
    });
    expect(trace.candidateIds).toHaveLength(MAX_TRACE_LIST);
    expect(trace.excluded).toHaveLength(MAX_TRACE_LIST);
    expect(Object.keys(trace.jev!.probabilities!)).toHaveLength(MAX_TRACE_LIST);
  });

  it("persists inside the existing receipt path without private payloads", () => {
    const trace = buildRouteTrace({
      dispatchId: "d-4",
      agent: "worker",
      startedAt: "a",
      endedAt: "b",
      candidateIds: ["alpha/fast"],
      excluded: [{ id: "gamma/open", reasons: ["circuit-open"] }],
      selectionSource: "fixed",
      selectedModel: "alpha/fast",
      outcome: "success",
    });
    const receipt = buildReceipt({
      dispatchId: "d-4",
      agent: "worker",
      identity: { provider: "alpha", id: "fast" },
      source: "fixed",
      preference: "balanced",
      eligibleIds: ["alpha/fast"],
      profileVersion: "v1",
      outcome: "success",
      task: "SECRET TASK TEXT",
      context: "SECRET CONTEXT",
      expectedOutput: "SECRET OUTPUT",
      routeTrace: trace,
    });
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain("SECRET TASK TEXT");
    expect(encoded).not.toContain("SECRET CONTEXT");
    expect(encoded).not.toContain("SECRET OUTPUT");
    expect(receipt.routeTrace).toMatchObject({ dispatchId: "d-4", selectionSource: "fixed" });
    expect(receipt.routeTrace!.filters.circuitOpen).toEqual(["gamma/open"]);
  });
});
