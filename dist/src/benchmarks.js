import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { modelKey } from "./types.js";
export const BENCHMARK_CACHE_VERSION = 1;
export const MAX_BENCHMARK_RECORDS_PER_MODEL = 8;
export const MAX_BENCHMARK_IMPORT_RECORDS = 256;
export const MAX_BENCHMARK_DIAGNOSTICS = 100;
export const MAX_BENCHMARK_TEXT = 120;
/** Absolute score bound shared by the parser AND every acquisition adapter. */
export const MAX_BENCHMARK_ABS_SCORE = 1_000_000_000;
export const MAX_BENCHMARK_URL = 2_048;
export const MAX_BENCHMARK_IMPORT_BYTES = 1_000_000;
export const MAX_BENCHMARK_AGE_MS = 730 * 24 * 60 * 60 * 1_000;
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedText(value) {
    if (typeof value !== "string")
        return undefined;
    const text = value.trim();
    if (text.length === 0 || text.length > MAX_BENCHMARK_TEXT || /[\u0000-\u001f\u007f]/u.test(text))
        return undefined;
    return text;
}
function safeSourceUrl(value) {
    if (typeof value !== "string" || value.length > MAX_BENCHMARK_URL)
        return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
            return undefined;
        return url.toString();
    }
    catch {
        return undefined;
    }
}
function exactDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
        return undefined;
    const time = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : undefined;
}
function diagnostic(category, index, identity) {
    return {
        category,
        ...(index !== undefined ? { index } : {}),
        ...(identity ? { model: modelKey(identity) } : {}),
    };
}
function parseIdentity(value) {
    if (!record(value))
        return undefined;
    const provider = boundedText(value.provider);
    const id = boundedText(value.id);
    return provider && id ? { provider, id } : undefined;
}
function parseShape(value) {
    if (!record(value))
        return { category: "malformed" };
    const identity = parseIdentity(value.model);
    const source = boundedText(value.source);
    const sourceUrl = safeSourceUrl(value.sourceUrl);
    const benchmark = boundedText(value.benchmark);
    const version = boundedText(value.version);
    const metric = boundedText(value.metric);
    const date = exactDate(value.date);
    const dateKind = value.dateKind === "source-reported" || value.dateKind === "retrieval-snapshot" ? value.dateKind : undefined;
    const provenance = value.provenance === "provider" || value.provenance === "independent" ? value.provenance : undefined;
    const score = typeof value.score === "number" && Number.isFinite(value.score) && Math.abs(value.score) <= MAX_BENCHMARK_ABS_SCORE ? value.score : undefined;
    const unit = boundedText(value.unit);
    const direction = value.direction === "higher-is-better" || value.direction === "lower-is-better" ? value.direction : undefined;
    if (typeof value.sourceUrl === "string" && !sourceUrl)
        return { category: "unsafe-source-url", ...(identity ? { identity } : {}) };
    if (!identity || !source || !sourceUrl || !benchmark || !version || !metric || !date || !dateKind || !provenance || score === undefined || !unit || !direction) {
        return { category: "malformed", ...(identity ? { identity } : {}) };
    }
    return { evidence: { model: identity, source, sourceUrl, benchmark, version, metric, date, dateKind, provenance, score, unit, direction }, identity };
}
export function benchmarkComparisonKey(value) {
    return [value.source, value.benchmark, value.version, value.metric, value.unit, value.direction, value.provenance].join("\u001f");
}
/**
 * Exact observation identity used for persistence/dedup. Unlike
 * `benchmarkComparisonKey` (the family key used for dominance/pruning), this
 * includes `date` and `score`, so genuinely distinct observations of the same
 * benchmark family are preserved rather than collapsed.
 */
export function benchmarkRecordKey(value) {
    return [modelKey(value.model), benchmarkComparisonKey(value), value.date, String(value.score)].join("\u001f");
}
/**
 * Strict parser for records already embedded in policy config.
 *
 * Config-embedded records go through the SAME bounds the acquisition path
 * enforces, including the 730-day age rule the setup help and README advertise.
 * Without it a hand-written config could carry a `2001-01-01` or `2099-12-31`
 * record into the chooser while the documented rule applied only to imported
 * data — the documented limit has to hold wherever a record can enter.
 */
export function parseConfiguredBenchmarks(value, identity, name, now = Date.now()) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`${name} must be an array`);
    if (value.length > MAX_BENCHMARK_RECORDS_PER_MODEL)
        throw new Error(`${name} must contain at most ${MAX_BENCHMARK_RECORDS_PER_MODEL} records`);
    const seen = new Set();
    const parsed = value.map((item, index) => {
        const result = parseShape(item);
        if (!result.evidence || modelKey(result.evidence.model) !== modelKey(identity))
            throw new Error(`${name}[${index}] is invalid or does not match the candidate identity`);
        const at = Date.parse(`${result.evidence.date}T00:00:00.000Z`);
        if (at > now)
            throw new Error(`${name}[${index}] is dated in the future (${result.evidence.date})`);
        if (now - at > MAX_BENCHMARK_AGE_MS)
            throw new Error(`${name}[${index}] is older than 730 days (${result.evidence.date})`);
        const key = benchmarkRecordKey(result.evidence);
        if (seen.has(key))
            throw new Error(`${name}[${index}] duplicates an existing benchmark record`);
        seen.add(key);
        return result.evidence;
    });
    return parsed.length > 0 ? parsed : undefined;
}
/** Validate untrusted external data record-by-record; ignored input yields stable diagnostics only. */
export function normalizeBenchmarkDocument(value, options) {
    const diagnostics = [];
    const records = [];
    const known = new Set(options.knownModels.map(modelKey));
    const now = (options.now ?? new Date()).getTime();
    if (!record(value) || value.version !== BENCHMARK_CACHE_VERSION || !Array.isArray(value.records)) {
        return { records, diagnostics: [diagnostic("malformed")] };
    }
    const input = value.records.slice(0, MAX_BENCHMARK_IMPORT_RECORDS);
    if (value.records.length > input.length)
        diagnostics.push(diagnostic("limit-exceeded"));
    const counts = new Map();
    const seen = new Set();
    for (let index = 0; index < input.length; index += 1) {
        const parsed = parseShape(input[index]);
        if (!parsed.evidence) {
            diagnostics.push(diagnostic(parsed.category ?? "malformed", index, parsed.identity));
            continue;
        }
        const evidence = parsed.evidence;
        const id = modelKey(evidence.model);
        if (!known.has(id)) {
            diagnostics.push(diagnostic("unmatched-model", index, evidence.model));
            continue;
        }
        const at = Date.parse(`${evidence.date}T00:00:00.000Z`);
        if (at > now) {
            diagnostics.push(diagnostic("future-dated", index, evidence.model));
            continue;
        }
        if (now - at > MAX_BENCHMARK_AGE_MS) {
            diagnostics.push(diagnostic("stale", index, evidence.model));
            continue;
        }
        const key = benchmarkRecordKey(evidence);
        if (seen.has(key))
            continue;
        const count = counts.get(id) ?? 0;
        if (count >= MAX_BENCHMARK_RECORDS_PER_MODEL) {
            diagnostics.push(diagnostic("limit-exceeded", index, evidence.model));
            continue;
        }
        seen.add(key);
        counts.set(id, count + 1);
        records.push(evidence);
    }
    return { records, diagnostics: diagnostics.slice(0, MAX_BENCHMARK_DIAGNOSTICS) };
}
export function benchmarkCachePath(agentDir = getAgentDir()) {
    return path.join(agentDir, "delegateau", "benchmarks.json");
}
/**
 * The exact bounded records a dispatch makes available to the model chooser:
 * every configured record on the eligible candidates, deduplicated by exact
 * identity and capped. Order follows the candidate list so the trace is stable.
 */
export const MAX_OFFERED_BENCHMARKS = 64;
export function collectBenchmarkEvidence(candidates, limit = MAX_OFFERED_BENCHMARKS) {
    const collected = [];
    const seen = new Set();
    for (const candidate of candidates) {
        for (const record of candidate.benchmarks ?? []) {
            if (collected.length >= limit)
                return collected;
            const key = benchmarkRecordKey(record);
            if (seen.has(key))
                continue;
            seen.add(key);
            collected.push(record);
        }
    }
    return collected;
}
export function readBenchmarkCache(filePath = benchmarkCachePath()) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return value?.version === BENCHMARK_CACHE_VERSION && Array.isArray(value.records) && Array.isArray(value.diagnostics) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
export function writeBenchmarkCache(cache, filePath = benchmarkCachePath()) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
}
/**
 * Insertion order decides which records survive the per-model cap, so the
 * caller passes the NEWEST records first and the cap evicts the oldest. Evicted
 * records are reported rather than silently dropped.
 */
function mergeRecords(newest, older) {
    const merged = new Map();
    for (const entry of newest)
        merged.set(benchmarkRecordKey(entry), entry);
    for (const entry of older) {
        const key = benchmarkRecordKey(entry);
        if (merged.has(key))
            continue;
        merged.set(key, entry);
    }
    const counts = new Map();
    const records = [];
    const diagnostics = [];
    for (const entry of merged.values()) {
        const id = modelKey(entry.model);
        const count = counts.get(id) ?? 0;
        if (count >= MAX_BENCHMARK_RECORDS_PER_MODEL) {
            diagnostics.push({ category: "limit-exceeded", model: id });
            continue;
        }
        counts.set(id, count + 1);
        records.push(entry);
    }
    return { records, diagnostics };
}
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
export function mergeBenchmarkReport(prior, report, options) {
    const revalidated = revalidateBenchmarkCache(prior, options);
    const merged = mergeRecords(report.records, revalidated.records);
    // Prior lists are not carried forward: `revalidated` already re-derives them
    // from the same records, and appending both duplicated every diagnostic on
    // each merge.
    const diagnostics = [...merged.diagnostics, ...revalidated.diagnostics, ...report.diagnostics];
    return {
        version: BENCHMARK_CACHE_VERSION,
        updatedAt: (options.now ?? new Date()).toISOString(),
        records: merged.records,
        diagnostics: dedupeDiagnostics(diagnostics),
    };
}
/** Diagnostics carry no timestamps, so identical entries are collapsed. */
function dedupeDiagnostics(diagnostics) {
    const seen = new Set();
    const unique = [];
    const dropped = diagnostics.length;
    for (const entry of diagnostics) {
        const key = JSON.stringify([entry.category, entry.index ?? null, entry.model ?? null, entry.sourceId ?? null]);
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(entry);
    }
    if (unique.length < dropped && unique.length < MAX_BENCHMARK_DIAGNOSTICS) {
        unique.push({ category: "limit-exceeded" });
    }
    return unique.slice(-MAX_BENCHMARK_DIAGNOSTICS);
}
/**
 * Re-validate persisted records against the current live registry and clock at
 * review time: a record that aged out, became future-dated, or no longer names a
 * live authenticated identity is demoted to a sanitized diagnostic and never
 * attached to a candidate.
 */
export function revalidateBenchmarkCache(cache, options) {
    return normalizeBenchmarkDocument({ version: BENCHMARK_CACHE_VERSION, records: cache?.records ?? [] }, options);
}
export async function importBenchmarkFile(filePath, options) {
    const readFile = options.readFile ?? (async (target) => fs.promises.readFile(target, "utf8"));
    const text = await readFile(filePath);
    if (Buffer.byteLength(text, "utf8") > MAX_BENCHMARK_IMPORT_BYTES)
        throw new Error(`Benchmark import exceeds ${MAX_BENCHMARK_IMPORT_BYTES} bytes`);
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        raw = undefined;
    }
    const report = normalizeBenchmarkDocument(raw, options);
    const prior = options.readCache ? await options.readCache() : readBenchmarkCache();
    const cache = mergeBenchmarkReport(prior, report, options);
    if (options.writeCache)
        await options.writeCache(cache);
    else
        writeBenchmarkCache(cache);
    // `imported` is what the file offered, `retained` is what survived the merge.
    // Reporting the first alone told the user a record was imported when the
    // per-model cap had already evicted it.
    const retainedKeys = new Set(cache.records.map(benchmarkRecordKey));
    const retained = report.records.filter((entry) => retainedKeys.has(benchmarkRecordKey(entry))).length;
    return {
        imported: report.records.length,
        retained,
        dropped: report.records.length - retained,
        records: cache.records,
        diagnostics: report.diagnostics,
    };
}
