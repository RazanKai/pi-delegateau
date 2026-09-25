import { type BenchmarkDiagnostic, type BenchmarkEvidence, type CandidateProfile, type ModelIdentity } from "./types.js";
export type { BenchmarkDiagnostic, BenchmarkDiagnosticCategory } from "./types.js";
export declare const BENCHMARK_CACHE_VERSION: 1;
export declare const MAX_BENCHMARK_RECORDS_PER_MODEL = 8;
export declare const MAX_BENCHMARK_IMPORT_RECORDS = 256;
export declare const MAX_BENCHMARK_DIAGNOSTICS = 100;
export declare const MAX_BENCHMARK_TEXT = 120;
/** Absolute score bound shared by the parser AND every acquisition adapter. */
export declare const MAX_BENCHMARK_ABS_SCORE = 1000000000;
export declare const MAX_BENCHMARK_URL = 2048;
export declare const MAX_BENCHMARK_IMPORT_BYTES = 1000000;
export declare const MAX_BENCHMARK_AGE_MS: number;
export interface BenchmarkImportReport {
    records: BenchmarkEvidence[];
    diagnostics: BenchmarkDiagnostic[];
}
export interface BenchmarkCache extends BenchmarkImportReport {
    version: 1;
    updatedAt: string;
}
export interface NormalizeBenchmarkOptions {
    knownModels: readonly ModelIdentity[];
    now?: Date;
}
export declare function benchmarkComparisonKey(value: BenchmarkEvidence): string;
/**
 * Exact observation identity used for persistence/dedup. Unlike
 * `benchmarkComparisonKey` (the family key used for dominance/pruning), this
 * includes `date` and `score`, so genuinely distinct observations of the same
 * benchmark family are preserved rather than collapsed.
 */
export declare function benchmarkRecordKey(value: BenchmarkEvidence): string;
/**
 * Parse records embedded in policy config.
 *
 * Config-embedded records go through the SAME bounds the acquisition path
 * enforces, including the documented 730-day age rule. Without it a hand-written
 * config could carry a `2001-01-01` or `2099-12-31` record into the chooser while
 * the documented rule applied only to imported data — the documented limit has to
 * hold wherever a record can enter.
 *
 * SHAPE errors still throw: a record that is malformed, names a different model,
 * or duplicates another is a config the author must fix. An AGE fault (stale or
 * future-dated) is DEMOTED instead — dropped from the candidate with a diagnostic,
 * leaving the candidate unmeasured — because age is not a config authoring
 * mistake: a valid config decays into invalidity purely by the passage of time.
 * Throwing there would make `loadConfig` uncaught-throw at dispatch and
 * session_start, so a config that worked for two years would one day stop the
 * whole extension from loading. That contradicts the contract that missing
 * evidence never removes a candidate.
 */
export declare function parseConfiguredBenchmarks(value: unknown, identity: ModelIdentity, name: string, now?: number): {
    benchmarks?: BenchmarkEvidence[];
    diagnostics: BenchmarkDiagnostic[];
};
/** Validate untrusted external data record-by-record; ignored input yields stable diagnostics only. */
export declare function normalizeBenchmarkDocument(value: unknown, options: NormalizeBenchmarkOptions): BenchmarkImportReport;
export declare function benchmarkCachePath(agentDir?: string): string;
/**
 * The exact bounded records a dispatch makes available to the model chooser:
 * every configured record on the eligible candidates, deduplicated by exact
 * identity and capped. Order follows the candidate list so the trace is stable.
 */
export declare const MAX_OFFERED_BENCHMARKS = 64;
export declare function collectBenchmarkEvidence(candidates: readonly CandidateProfile[], limit?: number): BenchmarkEvidence[];
export declare function readBenchmarkCache(filePath?: string): BenchmarkCache | undefined;
export declare function writeBenchmarkCache(cache: BenchmarkCache, filePath?: string): void;
/**
 * Merge an acquisition report into the persisted cache. Prior records are
 * revalidated against the current live registry and clock first, so stale,
 * future-dated or unmatched cache entries cannot crowd fresh evidence out of
 * the per-model cap. Exact observations are deduplicated by complete record
 * identity; unlike records and diagnostics are preserved, bounded by count.
 *
 * Ordering is the whole point: freshly acquired records are placed FIRST, so the
 * per-model cap evicts the oldest prior records rather than the record the user
 * just imported. Adding prior entries first made the command report a successful
 * import while silently dropping it. `evicted` reports what the cap removed.
 */
export declare function mergeBenchmarkReport(prior: BenchmarkCache | undefined, report: BenchmarkImportReport, options: NormalizeBenchmarkOptions): BenchmarkCache;
/**
 * Re-validate persisted records against the current live registry and clock at
 * review time: a record that aged out, became future-dated, or no longer names a
 * live authenticated identity is demoted to a sanitized diagnostic and never
 * attached to a candidate.
 */
export declare function revalidateBenchmarkCache(cache: BenchmarkCache | undefined, options: NormalizeBenchmarkOptions): BenchmarkImportReport;
export declare function importBenchmarkFile(filePath: string, options: NormalizeBenchmarkOptions & {
    readFile?: (filePath: string) => Promise<string>;
    readCache?: () => Promise<BenchmarkCache | undefined>;
    writeCache?: (cache: BenchmarkCache) => Promise<void>;
}): Promise<{
    imported: number;
    retained: number;
    dropped: number;
    records: BenchmarkEvidence[];
    diagnostics: BenchmarkDiagnostic[];
}>;
