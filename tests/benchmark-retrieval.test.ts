import { describe, expect, it, vi } from "vitest";
import {
  ARTIFICIAL_ANALYSIS_API_KEY_ENV,
  ARTIFICIAL_ANALYSIS_FREE_ENDPOINT,
  ARTIFICIAL_ANALYSIS_SOURCE,
  isAllowedRetrievalEndpoint,
  parseSourceModelMap,
  retrieveArtificialAnalysis,
} from "../src/benchmark-retrieval.js";
import * as roundTrip from "../src/benchmarks.js";

const live = [
  { provider: "openai-codex", id: "gpt-5.6-luna" },
  { provider: "ollama-cloud", id: "deepseek-v4.1-flash" },
];

const mapping = new Map([
  ["aa-uuid-luna", live[0]!],
  ["aa-uuid-sol", live[1]!],
  ["aa-uuid-deepseek", { provider: "ollama-cloud", id: "not-live" }],
]);

function response(data: unknown[], extra: Record<string, unknown> = {}) {
  const body = { tier: "free", intelligence_index_version: 4.1, data, ...extra };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return {
    ok: true,
    status: 200,
    body: stream,
  };
}

const datum = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: "Some Model",
  slug: "some-model",
  model_creator: { id: "creator-uuid", name: "Some Creator" },
  evaluations: {
    artificial_analysis_intelligence_index: 62.9,
    artificial_analysis_coding_index: 55.8,
    ...overrides,
  },
});

describe("Artificial Analysis v2 retrieval adapter", () => {
  it("parses an explicit stable-source-id mapping and rejects ambiguous input", () => {
    const parsed = parseSourceModelMap({
      source: ARTIFICIAL_ANALYSIS_SOURCE,
      mappings: [
        { sourceId: "aa-uuid-luna", provider: "openai-codex", id: "gpt-5.6-luna" },
      ],
    });
    expect(parsed.source).toBe(ARTIFICIAL_ANALYSIS_SOURCE);
    expect(parsed.mappings.get("aa-uuid-luna")).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });

    expect(() => parseSourceModelMap({ source: "other", mappings: [] })).toThrow(/source/);
    expect(() => parseSourceModelMap({ source: ARTIFICIAL_ANALYSIS_SOURCE, mappings: [] })).toThrow(/at least one/);
    expect(() => parseSourceModelMap({ source: ARTIFICIAL_ANALYSIS_SOURCE, mappings: [
      { sourceId: "dup", provider: "a", id: "b" },
      { sourceId: "dup", provider: "c", id: "d" },
    ] })).toThrow(/duplicate/);
    expect(() => parseSourceModelMap({ source: ARTIFICIAL_ANALYSIS_SOURCE, mappings: [{ sourceId: "", provider: "a", id: "b" }] })).toThrow(/sourceId/);
  });

  it("never issues a network request when the credential is absent", async () => {
    const fetchImpl = vi.fn();
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: undefined,
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.records).toEqual([]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["source-unavailable"]);
    expect(JSON.stringify(report)).not.toContain(ARTIFICIAL_ANALYSIS_API_KEY_ENV);
  });

  it("returns bounded normalized records for mapped live identities and ignores the rest", async () => {
    const richMapping = new Map([
      ["aa-uuid-luna", live[0]!],
      ["aa-uuid-deepseek", { provider: "ollama-cloud", id: "not-live" }],
      ["aa-uuid-empty", live[0]!],
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(response([
      datum("aa-uuid-luna"),
      datum("aa-uuid-deepseek"),
      datum("aa-uuid-unknown"),
      { id: "aa-uuid-empty", evaluations: {} },
    ]));
    const report = await retrieveArtificialAnalysis({
      mapping: richMapping,
      knownModels: live,
      credential: "test-secret-key",
      now: new Date("2026-09-24T10:00:00.000Z"),
      fetchImpl: fetchImpl as any,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(ARTIFICIAL_ANALYSIS_FREE_ENDPOINT);
    expect(init.headers["x-api-key"]).toBe("test-secret-key");

    // Two evaluation metrics for the one live mapped model.
    expect(report.records).toHaveLength(2);
    expect(report.records.map((entry) => entry.metric).sort()).toEqual([
      "artificial_analysis_coding_index",
      "artificial_analysis_intelligence_index",
    ]);
    for (const record of report.records) {
      expect(record.model).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
      expect(record.source).toBe(ARTIFICIAL_ANALYSIS_SOURCE);
      expect(record.sourceUrl).toBe("https://artificialanalysis.ai/");
      expect(record.benchmark).toBe("Artificial Analysis");
      expect(record.date).toBe("2026-09-24");
      expect(record.dateKind).toBe("retrieval-snapshot");
      expect(record.provenance).toBe("independent");
      expect(record.unit).toBe("points");
      expect(record.direction).toBe("higher-is-better");
      expect(Number.isFinite(record.score)).toBe(true);
    }
    // Only the Intelligence Index carries the response-level version; the
    // coding index is documented as not separately versioned.
    const byMetric = new Map(report.records.map((entry) => [entry.metric, entry]));
    expect(byMetric.get("artificial_analysis_intelligence_index")!.version).toBe("4.1");
    expect(byMetric.get("artificial_analysis_coding_index")!.version).toBe("unversioned");
    expect(report.diagnostics.map((entry) => entry.category)).toEqual([
      "unmatched-model", // mapped target is not a live authenticated identity
      "unmatched-model", // stable source id is not in the explicit mapping
      "malformed",       // mapped live model with no usable evaluations
    ]);
    expect(report.diagnostics.filter((entry) => entry.category === "unmatched-model").every((entry) => entry.sourceId !== undefined)).toBe(true);
    // Credentials never leak into persisted evidence.
    expect(JSON.stringify(report)).not.toContain("test-secret-key");
  });

  it("accepts only documented Free-tier composite indices and reports other numeric fields as unsupported", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([
      {
        id: "aa-uuid-luna",
        evaluations: {
          artificial_analysis_intelligence_index: 62.9,
          artificial_analysis_agentic_index: 27.6,
          mmlu_pro: 0.791,
          some_undocumented_metric: 12,
        },
      },
    ]));
    const report = await retrieveArtificialAnalysis({
      mapping: new Map([["aa-uuid-luna", live[0]!]]),
      knownModels: live,
      credential: "test-secret-key",
      now: new Date("2026-09-24T10:00:00.000Z"),
      fetchImpl: fetchImpl as any,
    });
    expect(report.records.map((entry) => entry.metric).sort()).toEqual([
      "artificial_analysis_agentic_index",
      "artificial_analysis_intelligence_index",
    ]);
    expect(report.records.find((entry) => entry.metric === "artificial_analysis_intelligence_index")!.version).toBe("4.1");
    expect(report.records.find((entry) => entry.metric === "artificial_analysis_agentic_index")!.version).toBe("unversioned");
    expect(report.records.every((entry) => entry.dateKind === "retrieval-snapshot")).toBe(true);
    expect(report.diagnostics).toEqual([
      { category: "unsupported-metric", sourceId: "aa-uuid-luna", model: "openai-codex/gpt-5.6-luna" },
      { category: "unsupported-metric", sourceId: "aa-uuid-luna", model: "openai-codex/gpt-5.6-luna" },
    ]);
    expect(JSON.stringify(report)).not.toContain("mmlu_pro");
  });

  it("treats a non-2xx response as an unavailable source rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, body: null });
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      fetchImpl: fetchImpl as any,
    });
    expect(report.records).toEqual([]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["source-unavailable"]);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("follows pagination within a hard bound and deduplicates exact records", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([datum("aa-uuid-luna")], { pagination: { has_more: true, page: 1, page_size: 1, total_pages: 3 } }))
      .mockResolvedValueOnce(response([datum("aa-uuid-sol")], { pagination: { has_more: true, page: 2, page_size: 1, total_pages: 3 } }))
      .mockResolvedValue(response([]));
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      maxPages: 5,
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Two metrics for each of the two mapped live models; page 3 is empty.
    expect(report.records).toHaveLength(4);
    expect(new Set(report.records.map((entry) => `${entry.model.id}/${entry.metric}`)).size).toBe(4);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("page=2");
  });

  it("stops paging when a page adds no new records instead of looping", async () => {
    // A provider that keeps advertising more pages while repeating the same
    // content must not be followed forever, and the cap must be reported.
    // A fresh response per call: a body stream can only be consumed once.
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(
      response([datum("aa-uuid-luna")], { pagination: { has_more: true, page: 1, page_size: 1, total_pages: 99 } }),
    ));
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      maxPages: 5,
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // One record per metric on the mapped model: the repeat of page 1 adds none.
    expect(report.records).toHaveLength(2);
    expect(report.diagnostics.map((entry) => entry.category)).toContain("limit-exceeded");
  });

  it("bounds a hung transport with a sanitized unavailable diagnostic", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      timeoutMs: 25,
      fetchImpl: fetchImpl as any,
    });
    expect(report.records).toEqual([]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["source-unavailable"]);
    expect(JSON.stringify(report)).not.toContain("test-secret-key");
  }, 2_000);

  it("bounds a hung body with a sanitized unavailable diagnostic", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }) });
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      timeoutMs: 25,
      fetchImpl: fetchImpl as any,
    });
    expect(report.records).toEqual([]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["source-unavailable"]);
    expect(JSON.stringify(report)).not.toContain("test-secret-key");
  }, 2_000);

  it("stops streaming once the response body exceeds the byte cap", async () => {
    let pulls = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(256)));
      },
      cancel() { canceled = true; },
    });
    const text = vi.fn(async () => "should not buffer via text()");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, body, text });
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      maxBodyBytes: 512,
      fetchImpl: fetchImpl as any,
    });
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["oversize"]);
    expect(text).not.toHaveBeenCalled();
    expect(pulls).toBeLessThan(6);
    expect(canceled).toBe(true);
  }, 2_000);

  it("rejects an oversize response before JSON parsing with a bounded diagnostic", async () => {
    const oversize = `{"data":[${JSON.stringify("x".repeat(4_096))}]}`;
    const bytes = new TextEncoder().encode(oversize);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      maxBodyBytes: 512,
      fetchImpl: fetchImpl as any,
    });
    expect(report.records).toEqual([]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["oversize"]);
    expect(JSON.stringify(report)).not.toContain("test-secret-key");
    expect(JSON.stringify(report).length).toBeLessThan(oversize.length);
  }, 2_000);

  it("emits records its own parser accepts, even for hostile field values", async () => {
    // The adapter previously passed the response's version and score through
    // unchecked, so a long version string or an out-of-bound score produced a
    // record that `normalizeBenchmarkDocument` discarded as malformed — the
    // import would look successful and then vanish at the next setup review.
    const bodyFor = (version: unknown) => ({
      tier: "free",
      intelligence_index_version: version,
      data: [
        // Out-of-bound score plus a null second metric: no usable record.
        datum("aa-uuid-luna", { artificial_analysis_intelligence_index: 1e300, artificial_analysis_coding_index: null }),
        datum("aa-uuid-sol", { artificial_analysis_intelligence_index: 42 }),
      ],
      pagination: { has_more: false },
    });
    const call = async (version: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(bodyFor(version)));
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      });
      return retrieveArtificialAnalysis({
        mapping,
        knownModels: live,
        credential: "test-secret-key",
        fetchImpl: fetchImpl as any,
      });
    };

    for (const version of [`4.1+${"x".repeat(400)}`, "4.1\u0007beta", undefined]) {
      const report = await call(version);
      // Two records for the good model; the unusable score is reported.
      expect(report.records.map((entry) => entry.metric)).toEqual([
        "artificial_analysis_intelligence_index",
        "artificial_analysis_coding_index",
      ]);
      expect(report.records.every((entry) => entry.version === "unversioned")).toBe(true);
      // One for the out-of-bound score, one for the model left with no usable
      // evaluation. Both are reported, neither becomes a record.
      expect(report.diagnostics.map((entry) => entry.category)).toEqual(["malformed", "malformed"]);

      // The decisive assertion: whatever the adapter emits must survive the
      // project's own strict parser, which is what config and cache reads use.
      const normalized = roundTrip.normalizeBenchmarkDocument(
        { version: 1, records: report.records },
        { knownModels: live, now: new Date() },
      );
      expect(normalized.records).toHaveLength(report.records.length);
      expect(normalized.diagnostics).toEqual([]);
    }
  }, 5_000);

  it("refuses a credentialed request to any host but the documented one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([datum("aa-uuid-luna")]));
    const report = await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      endpoint: "https://not-artificialanalysis.example/api/v2/language/models/free",
      fetchImpl: fetchImpl as any,
    });
    // The key is never sent anywhere else: no request is made at all.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.records).toEqual([]);
    expect(report.diagnostics.map((entry) => entry.category)).toEqual(["source-unavailable"]);
  }, 2_000);

  it("asks the transport to refuse redirects so the key cannot be replayed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([datum("aa-uuid-luna")]));
    await retrieveArtificialAnalysis({
      mapping,
      knownModels: live,
      credential: "test-secret-key",
      fetchImpl: fetchImpl as any,
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.redirect).toBe("error");
    expect(isAllowedRetrievalEndpoint(String(fetchImpl.mock.calls[0]![0]))).toBe(true);
    expect(isAllowedRetrievalEndpoint("https://evil.example/v2/language/models/free")).toBe(false);
  }, 2_000);
});
