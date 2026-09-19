import type { ModelIdentity } from "./types.js";
export interface ProbeResult {
    identity: ModelIdentity;
    reachable: boolean;
    /** Stable error class only — never raw provider text. */
    errorCategory?: "unsupported-model" | "auth" | "quota" | "network" | "timeout" | "unknown-error";
    latencyMs?: number;
    probedAt: string;
}
export interface ProbeCache {
    version: 1;
    probedAt: string;
    results: ProbeResult[];
}
export declare const PROBE_CACHE_VERSION = 1;
/** A day is the freshness window; one probe per day, not per session. */
export declare const PROBE_MAX_AGE_MS: number;
export declare function probeCachePath(agentDir?: string): string;
/**
 * Classify a probe failure into a stable category. Raw provider text is never
 * persisted (same rule as receipts): a category is enough to decide routing,
 * and provider bodies can echo request content.
 */
export declare function categorizeProbeError(message: string): ProbeResult["errorCategory"];
export declare function readProbeCache(filePath?: string): ProbeCache | undefined;
export declare function isProbeCacheFresh(cache: ProbeCache | undefined, now?: number): boolean;
export declare function writeProbeCache(cache: ProbeCache, filePath?: string): void;
/**
 * Look up whether a model is known-unreachable. A model with no probe entry is
 * treated as reachable: absence of evidence is not evidence of absence, and
 * blocking an unprobed model would silently shrink the pool (which is the bug
 * this whole change exists to fix).
 */
export declare function isKnownUnreachable(identity: ModelIdentity, cache: ProbeCache | undefined): boolean;
export interface ProbeRunOptions {
    /** Absolute path to the pi executable; defaults to PATH lookup. */
    command?: string;
    cwd: string;
    /** Models to probe. */
    targets: ModelIdentity[];
    /** Keep background probes offline; explicit setup probes may opt into live calls. */
    offline?: boolean;
    signal?: AbortSignal;
    onResult?: (result: ProbeResult) => void;
}
/**
 * Probe one model by running a trivial one-shot through the real child path.
 * Uses the same launch shape as dispatch so the probe exercises what dispatch
 * will actually do — a probe that used a different path could pass while
 * dispatch fails.
 */
export declare function probeModel(identity: ModelIdentity, options: ProbeRunOptions): Promise<ProbeResult>;
/**
 * Probe every target, sequentially (never in parallel: a burst of simultaneous
 * calls is exactly what trips rate limits and would produce false negatives).
 */
export declare function runProbe(options: ProbeRunOptions): Promise<ProbeCache>;
/**
 * Start a probe in the background if the cache is stale. Returns a handle whose
 * abort() cancels outstanding probes on session shutdown. Never throws and never
 * blocks: a probe failure must not affect the session.
 */
export declare function startBackgroundProbe(options: ProbeRunOptions & {
    cachePath?: string;
    force?: boolean;
}): {
    abort: () => void;
    done: Promise<ProbeCache | undefined>;
};
/** Default working directory for probes: never a user project. */
export declare function probeWorkingDir(): string;
