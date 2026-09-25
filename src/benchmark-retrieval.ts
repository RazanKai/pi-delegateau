import {
  MAX_BENCHMARK_ABS_SCORE,
  MAX_BENCHMARK_DIAGNOSTICS,
  MAX_BENCHMARK_TEXT,
  benchmarkRecordKey,
  type BenchmarkDiagnostic,
  type BenchmarkImportReport,
} from "./benchmarks.js";
import { modelKey, type BenchmarkDirection, type BenchmarkEvidence, type ModelIdentity } from "./types.js";

/**
 * Explicit Artificial Analysis v2 retrieval adapter.
 *
 * PRIMARY-SOURCE GROUNDING (researched 2026-09-24):
 * - https://artificialanalysis.ai/data-api/docs documents base URL
 *   `https://artificialanalysis.ai/api/v2`, an `x-api-key` header, and the
 *   Free-tier language-model endpoint `GET /api/v2/language/models/free`.
 * - https://artificialanalysis.ai/data-api/migrate-v2-data states the legacy
 *   `/api/v2/data/llms/models` path retires 2026-11-04; the supported Free
 *   replacement is `/api/v2/language/models/free`.
 * - The overview recommends model and creator `id`s (stable UUIDs) as primary
 *   identifiers because names and slugs may change. This adapter therefore
 *   requires a user-authored mapping from those stable `id`s to exact live Pi
 *   `provider/model` identities and NEVER guesses an alias from a name or slug.
 *
 * SAFETY: this module performs no network I/O unless `credential` is a
 * non-empty string AND the caller invokes `retrieveArtificialAnalysis`. The
 * credential is read from the process environment by the command layer, is
 * sent only in the request header, and is never returned, persisted or logged.
 * A missing credential or a non-2xx response becomes a sanitized
 * `source-unavailable` diagnostic, never a throw and never a fabricated record.
 */

export const ARTIFICIAL_ANALYSIS_SOURCE = "artificial-analysis";
export const ARTIFICIAL_ANALYSIS_SOURCE_URL = "https://artificialanalysis.ai/";
export const ARTIFICIAL_ANALYSIS_HOST = "artificialanalysis.ai";
/** The only host a credentialed benchmark request is ever sent to. */
export const ALLOWED_RETRIEVAL_HOST = ARTIFICIAL_ANALYSIS_HOST;
export const ARTIFICIAL_ANALYSIS_FREE_ENDPOINT = `https://${ARTIFICIAL_ANALYSIS_HOST}/api/v2/language/models/free`;
export const ARTIFICIAL_ANALYSIS_API_KEY_ENV = "ARTIFICIAL_ANALYSIS_API_KEY";
export const ARTIFICIAL_ANALYSIS_BENCHMARK = "Artificial Analysis";
export const MAX_SOURCE_MAP_ENTRIES = 512;
export const MAX_RETRIEVAL_RECORDS = 512;
export const MAX_RETRIEVAL_PAGES = 5;
/** Default deadline covering the request and body read. */
export const RETRIEVAL_TIMEOUT_MS = 10_000;
/** Hard upper bound callers cannot raise the deadline past. */
export const MAX_RETRIEVAL_TIMEOUT_MS = 30_000;
/** Hard cap on response body bytes enforced before JSON parsing. */
export const MAX_RETRIEVAL_BODY_BYTES = 1_000_000;

interface AllowedMetric {
  unit: string;
  direction: BenchmarkDirection;
  /** `intelligence-index` uses the response-level version; `unversioned` is documented as not separately versioned. */
  version: "intelligence-index" | "unversioned";
}

/**
 * The only Free-tier fields this adapter promotes. The Free-tier contract
 * documents `evaluations` as composite Artificial Analysis indices and exposes
 * no per-benchmark scores, no per-metric direction, and no per-metric unit;
 * the Intelligence Index carries `intelligence_index_version`, while the
 * coding and agentic indices are documented as derived from subsets of those
 * evaluations and "not separately versioned". Any other numeric field is
 * classified as an unsupported diagnostic rather than invented into a record.
 * Sources:
 * - https://artificialanalysis.ai/data-api/docs (Free language-models body)
 * - https://artificialanalysis.ai/api-reference
 */
export const ALLOWED_ARTIFICIAL_ANALYSIS_METRICS: Readonly<Record<string, AllowedMetric>> = {
  artificial_analysis_intelligence_index: { unit: "points", direction: "higher-is-better", version: "intelligence-index" },
  artificial_analysis_coding_index: { unit: "points", direction: "higher-is-better", version: "unversioned" },
  artificial_analysis_agentic_index: { unit: "points", direction: "higher-is-better", version: "unversioned" },
};

export interface SourceModelMap {
  source: string;
  mappings: Map<string, ModelIdentity>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max = MAX_BENCHMARK_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) return undefined;
  return text;
}

function identityFrom(value: unknown): ModelIdentity | undefined {
  if (!record(value)) return undefined;
  const provider = bounded(value.provider);
  const id = bounded(value.id);
  return provider && id ? { provider, id } : undefined;
}

/**
 * Parse the explicit stable-source-id -> exact live Pi identity mapping.
 * Canonical shape:
 *   { "source": "artificial-analysis",
 *     "mappings": [ { "sourceId": "<aa model id>", "provider": "…", "id": "…" } ] }
 */
export function parseSourceModelMap(value: unknown, expectedSource = ARTIFICIAL_ANALYSIS_SOURCE): SourceModelMap {
  if (!record(value)) throw new Error("benchmark mapping must be a JSON object");
  const source = bounded(value.source, 64);
  if (source !== expectedSource) throw new Error(`benchmark mapping source must be "${expectedSource}"`);
  if (!Array.isArray(value.mappings)) throw new Error("benchmark mapping must contain a mappings array");
  if (value.mappings.length === 0) throw new Error("benchmark mapping must contain at least one entry");
  if (value.mappings.length > MAX_SOURCE_MAP_ENTRIES) throw new Error(`benchmark mapping must contain at most ${MAX_SOURCE_MAP_ENTRIES} entries`);
  const mappings = new Map<string, ModelIdentity>();
  value.mappings.forEach((entry, index) => {
    if (!record(entry)) throw new Error(`mappings[${index}] must be an object`);
    const sourceId = bounded(entry.sourceId, 200);
    if (!sourceId) throw new Error(`mappings[${index}].sourceId must be a bounded non-empty string`);
    if (mappings.has(sourceId)) throw new Error(`duplicate sourceId in benchmark mapping: ${sourceId}`);
    const identity = identityFrom(entry);
    if (!identity) throw new Error(`mappings[${index}] must name exact provider and id`);
    mappings.set(sourceId, identity);
  });
  return { source, mappings };
}

export interface RetrievalFetchResponse {
  ok: boolean;
  status: number;
  /** Raw stream so the adapter can enforce its byte budget while reading. */
  body: ReadableStream<Uint8Array> | null;
}

export type RetrievalFetch = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal?: AbortSignal;
    /**
     * Credentialed retrieval must not follow a redirect: the `x-api-key` header
     * would be replayed to whatever host the response names. `"error"` makes a
     * redirect a visible transport failure instead of a silent credential leak.
     */
    redirect: "error";
  },
) => Promise<RetrievalFetchResponse>;

export interface ArtificialAnalysisOptions {
  /** Stable Artificial Analysis model id -> exact live Pi identity. */
  mapping: ReadonlyMap<string, ModelIdentity>;
  /** Exact identities currently present in the live authenticated Pi registry. */
  knownModels: readonly ModelIdentity[];
  /** Credential from the process environment; absent means no request is made. */
  credential?: string | undefined;
  now?: Date;
  endpoint?: string;
  maxPages?: number;
  /** Bounded deadline covering fetch and body parsing; defaults to RETRIEVAL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Hard cap on response body bytes before parsing; defaults to MAX_RETRIEVAL_BODY_BYTES. */
  maxBodyBytes?: number;
  fetchImpl?: RetrievalFetch;
}

function responseDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The response-level index version, bounded exactly like a persisted version. */
function indexVersionLabel(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  // Anything the record parser would reject must not be emitted here: a label
  // that is too long or carries control characters is normalized to the same
  // placeholder as a missing one, so the adapter cannot produce a record its own
  // parser (and therefore the next setup review) throws away as malformed.
  return bounded(value, MAX_BENCHMARK_TEXT) ?? "unversioned";
}

/**
 * A score is only usable if the shared bound accepts it. An out-of-bound or
 * non-finite number is skipped here rather than turned into a record that the
 * parser rejects on the next read.
 */
function usableScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.abs(value) <= MAX_BENCHMARK_ABS_SCORE ? value : undefined;
}

/**
 * Adapt the runtime `fetch` to the narrow retrieval seam without a type
 * assertion. Redirects are refused so the credential header is never replayed
 * to a host the caller did not name.
 */
function runtimeFetch(): RetrievalFetch | undefined {
  if (typeof globalThis.fetch !== "function") return undefined;
  const globalFetch = globalThis.fetch;
  return (url, init) => globalFetch(url, init);
}

/** The exact host a credentialed request may be sent to. */
export function isAllowedRetrievalEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === ALLOWED_RETRIEVAL_HOST;
  } catch {
    return false;
  }
}

function sourceUnavailable(): BenchmarkDiagnostic {
  return { category: "source-unavailable" };
}

/**
 * Resolve `value` or reject once `timeoutMs` elapses. The timeout callback can
 * abort the underlying request so a real transport does not keep running after
 * the caller has already observed the bounded failure. Any late settlement is
 * discarded by the already-settled promise and never surfaces unhandled.
 */
function withDeadline<T>(value: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("retrieval deadline exceeded"));
    }, timeoutMs);
    value.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

type PageResult =
  | { kind: "ok"; body: unknown }
  | { kind: "unavailable" }
  | { kind: "malformed" }
  | { kind: "oversize" };

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBodyBytes: number): Promise<{ kind: "ok"; text: string } | { kind: "malformed" } | { kind: "oversize" }> {
  if (!body) return { kind: "malformed" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBodyBytes) {
        // Cancel immediately; do not buffer or parse the remainder of the body.
        void reader.cancel().catch(() => undefined);
        return { kind: "oversize" };
      }
      chunks.push(chunk);
    }
  } catch {
    return { kind: "malformed" };
  } finally {
    try { reader.releaseLock(); } catch { /* cancellation may already release it */ }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { kind: "ok", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "malformed" };
  }
}

/** One page round trip; transport/provider failure and body failure stay distinct. */
async function fetchRetrievedPage(fetcher: RetrievalFetch, url: string, credential: string, timeoutMs: number, maxBodyBytes: number): Promise<PageResult> {
  if (!isAllowedRetrievalEndpoint(url)) return { kind: "unavailable" };
  const controller = new AbortController();
  const operation = (async (): Promise<PageResult> => {
    const response = await fetcher(url, { headers: { "x-api-key": credential, accept: "application/json" }, signal: controller.signal, redirect: "error" });
    if (!response.ok) return { kind: "unavailable" };
    const body = await readBoundedBody(response.body, maxBodyBytes);
    if (body.kind !== "ok") return body;
    try {
      return { kind: "ok", body: JSON.parse(body.text) };
    } catch {
      return { kind: "malformed" };
    }
  })();
  try {
    return await withDeadline(operation, timeoutMs, () => controller.abort());
  } catch {
    return { kind: "unavailable" };
  }
}

interface NormalizeContext {
  mapping: ReadonlyMap<string, ModelIdentity>;
  known: ReadonlySet<string>;
  version: string;
  date: string;
}

/**
 * Normalize one Artificial Analysis model entry. Only an explicitly mapped
 * identity that is also in the live authenticated registry yields records;
 * every other outcome is a bounded diagnostic and no record.
 */
function normalizeRetrievedModel(datum: unknown, ctx: NormalizeContext): { records: BenchmarkEvidence[]; diagnostics: BenchmarkDiagnostic[] } {
  if (!record(datum)) return { records: [], diagnostics: [{ category: "malformed" }] };
  const sourceId = bounded(datum.id, 200);
  if (!sourceId) return { records: [], diagnostics: [{ category: "malformed" }] };
  const identity = ctx.mapping.get(sourceId);
  if (!identity) return { records: [], diagnostics: [{ category: "unmatched-model", sourceId }] };
  const model = modelKey(identity);
  if (!ctx.known.has(model)) return { records: [], diagnostics: [{ category: "unmatched-model", sourceId, model }] };
  if (!record(datum.evaluations)) return { records: [], diagnostics: [{ category: "malformed", sourceId, model }] };
  const records: BenchmarkEvidence[] = [];
  const diagnostics: BenchmarkDiagnostic[] = [];
  let usable = 0;
  let unsupported = 0;
  for (const [metric, rawScore] of Object.entries(datum.evaluations)) {
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) continue;
    const allowed = ALLOWED_ARTIFICIAL_ANALYSIS_METRICS[metric];
    if (!allowed) {
      unsupported += 1;
      diagnostics.push({ category: "unsupported-metric", sourceId, model });
      continue;
    }
    const score = usableScore(rawScore);
    if (score === undefined) {
      // A value outside the persisted bound is reported, not turned into a
      // record the parser would reject on the next read.
      diagnostics.push({ category: "malformed", sourceId, model });
      continue;
    }
    usable += 1;
    records.push({
      model: { provider: identity.provider, id: identity.id },
      source: ARTIFICIAL_ANALYSIS_SOURCE,
      sourceUrl: ARTIFICIAL_ANALYSIS_SOURCE_URL,
      benchmark: ARTIFICIAL_ANALYSIS_BENCHMARK,
      version: allowed.version === "intelligence-index" ? ctx.version : "unversioned",
      metric,
      date: ctx.date,
      dateKind: "retrieval-snapshot",
      provenance: "independent",
      score,
      unit: allowed.unit,
      direction: allowed.direction,
    });
  }
  if (usable === 0 && unsupported === 0) diagnostics.push({ category: "malformed", sourceId, model });
  return { records, diagnostics };
}

/**
 * Fetch and normalize Artificial Analysis evaluations for explicitly mapped
 * live identities. Pure with respect to injected `fetchImpl`; the default uses
 * the runtime `fetch`. The function never throws for a transport/provider
 * failure and never returns an unvalidated score.
 */
export async function retrieveArtificialAnalysis(options: ArtificialAnalysisOptions): Promise<BenchmarkImportReport> {
  const records: BenchmarkEvidence[] = [];
  const diagnostics: BenchmarkDiagnostic[] = [];
  const credential = typeof options.credential === "string" ? options.credential.trim() : "";
  if (!credential) return { records, diagnostics: [sourceUnavailable()] };

  const known = new Set(options.knownModels.map(modelKey));
  const endpoint = options.endpoint ?? ARTIFICIAL_ANALYSIS_FREE_ENDPOINT;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? MAX_RETRIEVAL_PAGES, MAX_RETRIEVAL_PAGES));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? RETRIEVAL_TIMEOUT_MS, MAX_RETRIEVAL_TIMEOUT_MS));
  const maxBodyBytes = Math.max(1, Math.min(options.maxBodyBytes ?? MAX_RETRIEVAL_BODY_BYTES, MAX_RETRIEVAL_BODY_BYTES));
  const date = responseDate(options.now ?? new Date());
  const seen = new Set<string>();
  const fetcher = options.fetchImpl ?? runtimeFetch();
  if (typeof fetcher !== "function") return { records, diagnostics: [sourceUnavailable()] };

  let capped = false;
  for (let page = 1; page <= maxPages && !capped; page += 1) {
    const url = page === 1 ? endpoint : `${endpoint}?page=${page}`;
    const result = await fetchRetrievedPage(fetcher, url, credential, timeoutMs, maxBodyBytes);
    if (result.kind === "unavailable") {
      diagnostics.push(sourceUnavailable());
      break;
    }
    if (result.kind === "malformed") {
      diagnostics.push({ category: "malformed" });
      break;
    }
    if (result.kind === "oversize") {
      diagnostics.push({ category: "oversize" });
      break;
    }
    const body = result.body;
    if (!record(body) || !Array.isArray(body.data)) {
      diagnostics.push({ category: "malformed" });
      break;
    }
    const ctx: NormalizeContext = { mapping: options.mapping, known, version: indexVersionLabel(body.intelligence_index_version), date };
    const before = records.length;
    for (const datum of body.data) {
      const normalized = normalizeRetrievedModel(datum, ctx);
      diagnostics.push(...normalized.diagnostics);
      for (const record of normalized.records) {
        if (records.length >= MAX_RETRIEVAL_RECORDS) {
          diagnostics.push({ category: "limit-exceeded" });
          capped = true;
          break;
        }
        const key = benchmarkRecordKey(record);
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
      if (capped) break;
    }
    if (capped) break;
    const pagination = body.pagination;
    const hasMore = record(pagination) && pagination.has_more === true;
    if (!hasMore) break;
    // A provider that keeps reporting more pages while offering no page number
    // would loop on page 1 forever; every later page here is `?page=N`, so a page
    // that yields nothing new ends the scan. This is a cap being reached, not
    // evidence of a provider fault.
    if (records.length === before) {
      diagnostics.push({ category: "limit-exceeded" });
      break;
    }
    if (page === maxPages) diagnostics.push({ category: "limit-exceeded" });
  }
  return { records, diagnostics: diagnostics.slice(0, MAX_BENCHMARK_DIAGNOSTICS) };
}
