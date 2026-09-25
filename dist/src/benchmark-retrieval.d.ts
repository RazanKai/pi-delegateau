import { type BenchmarkImportReport } from "./benchmarks.js";
import { type BenchmarkDirection, type ModelIdentity } from "./types.js";
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
export declare const ARTIFICIAL_ANALYSIS_SOURCE = "artificial-analysis";
export declare const ARTIFICIAL_ANALYSIS_SOURCE_URL = "https://artificialanalysis.ai/";
export declare const ARTIFICIAL_ANALYSIS_HOST = "artificialanalysis.ai";
/** The only host a credentialed benchmark request is ever sent to. */
export declare const ALLOWED_RETRIEVAL_HOST = "artificialanalysis.ai";
export declare const ARTIFICIAL_ANALYSIS_FREE_ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models/free";
export declare const ARTIFICIAL_ANALYSIS_API_KEY_ENV = "ARTIFICIAL_ANALYSIS_API_KEY";
export declare const ARTIFICIAL_ANALYSIS_BENCHMARK = "Artificial Analysis";
export declare const MAX_SOURCE_MAP_ENTRIES = 512;
export declare const MAX_RETRIEVAL_RECORDS = 512;
export declare const MAX_RETRIEVAL_PAGES = 5;
/** Default deadline covering the request and body read. */
export declare const RETRIEVAL_TIMEOUT_MS = 10000;
/** Hard upper bound callers cannot raise the deadline past. */
export declare const MAX_RETRIEVAL_TIMEOUT_MS = 30000;
/** Hard cap on response body bytes enforced before JSON parsing. */
export declare const MAX_RETRIEVAL_BODY_BYTES = 1000000;
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
export declare const ALLOWED_ARTIFICIAL_ANALYSIS_METRICS: Readonly<Record<string, AllowedMetric>>;
export interface SourceModelMap {
    source: string;
    mappings: Map<string, ModelIdentity>;
}
/**
 * Parse the explicit stable-source-id -> exact live Pi identity mapping.
 * Canonical shape:
 *   { "source": "artificial-analysis",
 *     "mappings": [ { "sourceId": "<aa model id>", "provider": "…", "id": "…" } ] }
 */
export declare function parseSourceModelMap(value: unknown, expectedSource?: string): SourceModelMap;
export interface RetrievalFetchResponse {
    ok: boolean;
    status: number;
    /** Raw stream so the adapter can enforce its byte budget while reading. */
    body: ReadableStream<Uint8Array> | null;
}
export type RetrievalFetch = (url: string, init: {
    headers: Record<string, string>;
    signal?: AbortSignal;
    /**
     * Credentialed retrieval must not follow a redirect: the `x-api-key` header
     * would be replayed to whatever host the response names. `"error"` makes a
     * redirect a visible transport failure instead of a silent credential leak.
     */
    redirect: "error";
}) => Promise<RetrievalFetchResponse>;
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
/** The exact host a credentialed request may be sent to. */
export declare function isAllowedRetrievalEndpoint(url: string): boolean;
/**
 * Fetch and normalize Artificial Analysis evaluations for explicitly mapped
 * live identities. Pure with respect to injected `fetchImpl`; the default uses
 * the runtime `fetch`. The function never throws for a transport/provider
 * failure and never returns an unvalidated score.
 */
export declare function retrieveArtificialAnalysis(options: ArtificialAnalysisOptions): Promise<BenchmarkImportReport>;
export {};
