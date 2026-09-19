import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
/**
 * Reachability probe.
 *
 * WHY: Pi's model registry lists models that the provider will actually refuse.
 * Measured on this machine, `openai-codex/gpt-5.4-mini`, `gpt-5.4` and
 * `gpt-5.3-codex-spark` are all listed with prices and all pass the eligibility
 * check (`find()` + `hasConfiguredAuth()`), yet every one returns
 * "The model is not supported when using Codex with a ChatGPT account." So
 * eligibility proves a credential exists, not that the model is SERVED, and an
 * unusable model wastes a dispatch that the user paid for.
 *
 * DESIGN: this is deliberately NOT a benchmark. It answers exactly one question
 * — does this model answer a trivial prompt right now — and never touches
 * prices, capabilities or descriptions (those belong to the provider's own
 * catalog). It runs detached from `session_start`, so nothing on the dispatch
 * path ever waits for it, and its result is cached for a day: the pool is
 * resolved at config load and dispatch time, so a probe that finished LAST
 * session is perfectly usable. Zero added latency by construction.
 */
/** Attach a failure category without violating exactOptionalPropertyTypes. */
function withCategory(base, errorCategory) {
    return { ...base, ...(errorCategory ? { errorCategory } : {}) };
}
export const PROBE_CACHE_VERSION = 1;
/** A day is the freshness window; one probe per day, not per session. */
export const PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_PROMPT = "Reply with only: OK";
export function probeCachePath(agentDir = getAgentDir()) {
    return path.join(agentDir, "delegateau", "reachability.json");
}
/**
 * Classify a probe failure into a stable category. Raw provider text is never
 * persisted (same rule as receipts): a category is enough to decide routing,
 * and provider bodies can echo request content.
 */
export function categorizeProbeError(message) {
    const text = message.toLowerCase();
    if (text.includes("not supported when using codex") || text.includes("model is not supported"))
        return "unsupported-model";
    if (text.includes("free tier") || text.includes("can only be used from within"))
        return "unsupported-model";
    if (text.includes("401") || text.includes("auth") || text.includes("credential") || text.includes("api key"))
        return "auth";
    if (text.includes("quota") || text.includes("429") || text.includes("rate limit") || text.includes("usage limit"))
        return "quota";
    if (text.includes("timed out") || text.includes("timeout"))
        return "timeout";
    if (text.includes("enotfound") || text.includes("econnrefused") || text.includes("network") || text.includes("fetch failed"))
        return "network";
    return "unknown-error";
}
export function readProbeCache(filePath = probeCachePath()) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!raw || raw.version !== PROBE_CACHE_VERSION || !Array.isArray(raw.results))
            return undefined;
        return raw;
    }
    catch {
        return undefined;
    }
}
export function isProbeCacheFresh(cache, now = Date.now()) {
    if (!cache)
        return false;
    const at = Date.parse(cache.probedAt);
    if (!Number.isFinite(at))
        return false;
    return now - at < PROBE_MAX_AGE_MS;
}
export function writeProbeCache(cache, filePath = probeCachePath()) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
}
/**
 * Look up whether a model is known-unreachable. A model with no probe entry is
 * treated as reachable: absence of evidence is not evidence of absence, and
 * blocking an unprobed model would silently shrink the pool (which is the bug
 * this whole change exists to fix).
 */
export function isKnownUnreachable(identity, cache) {
    if (!cache)
        return false;
    const found = cache.results.find((r) => r.identity.provider === identity.provider && r.identity.id === identity.id);
    return found ? !found.reachable : false;
}
/**
 * Probe one model by running a trivial one-shot through the real child path.
 * Uses the same launch shape as dispatch so the probe exercises what dispatch
 * will actually do — a probe that used a different path could pass while
 * dispatch fails.
 */
export function probeModel(identity, options) {
    const started = Date.now();
    const probedAt = new Date().toISOString();
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        let child;
        try {
            child = spawn(options.command ?? "pi", [
                "--offline",
                "--no-session",
                "--no-extensions",
                "--provider", identity.provider,
                "--model", identity.id,
                "-p", PROBE_PROMPT,
            ], {
                cwd: options.cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            finish(withCategory({ identity, reachable: false, probedAt }, categorizeProbeError(String(error))));
            return;
        }
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish({ identity, reachable: false, errorCategory: "timeout", probedAt });
        }, PROBE_TIMEOUT_MS);
        const onAbort = () => {
            child.kill("SIGTERM");
            finish({ identity, reachable: false, errorCategory: "timeout", probedAt });
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => { stdout += chunk; });
        child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
        child.on("error", (error) => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            finish(withCategory({ identity, reachable: false, probedAt }, categorizeProbeError(String(error))));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            const combined = `${stdout}\n${stderr}`;
            // "Reachable" means the model produced an answer. A zero exit alone is not
            // enough: provider errors surface as assistant text with a zero exit.
            const answered = /\bOK\b/.test(stdout) && !/not supported when using codex/i.test(combined) && !/\berror\b/i.test(stderr);
            if (answered && code === 0) {
                finish({ identity, reachable: true, latencyMs: Date.now() - started, probedAt });
                return;
            }
            finish(withCategory({ identity, reachable: false, latencyMs: Date.now() - started, probedAt }, categorizeProbeError(combined)));
        });
    });
}
/**
 * Probe every target, sequentially (never in parallel: a burst of simultaneous
 * calls is exactly what trips rate limits and would produce false negatives).
 */
export async function runProbe(options) {
    const results = [];
    for (const target of options.targets) {
        if (options.signal?.aborted)
            break;
        const result = await probeModel(target, options);
        results.push(result);
        options.onResult?.(result);
    }
    const cache = { version: PROBE_CACHE_VERSION, probedAt: new Date().toISOString(), results };
    return cache;
}
/**
 * Start a probe in the background if the cache is stale. Returns a handle whose
 * abort() cancels outstanding probes on session shutdown. Never throws and never
 * blocks: a probe failure must not affect the session.
 */
export function startBackgroundProbe(options) {
    const controller = new AbortController();
    const existing = readProbeCache(options.cachePath);
    if (!options.force && isProbeCacheFresh(existing)) {
        return { abort: () => controller.abort(), done: Promise.resolve(undefined) };
    }
    const targets = options.targets.filter((t) => !isKnownUnreachable(t, existing) || options.force);
    const done = (async () => {
        try {
            // Sequential, bounded and detached from any user-visible path.
            const fresh = await runProbe({ ...options, targets, signal: controller.signal });
            // Merge with prior results so a model that was not re-probed keeps its
            // last known state rather than becoming "unprobed" again.
            const merged = new Map();
            for (const r of existing?.results ?? [])
                merged.set(`${r.identity.provider}/${r.identity.id}`, r);
            for (const r of fresh.results)
                merged.set(`${r.identity.provider}/${r.identity.id}`, r);
            const cache = { version: PROBE_CACHE_VERSION, probedAt: fresh.probedAt, results: [...merged.values()] };
            writeProbeCache(cache, options.cachePath);
            return cache;
        }
        catch {
            return undefined;
        }
    })();
    return { abort: () => controller.abort(), done };
}
/** Default working directory for probes: never a user project. */
export function probeWorkingDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegateau-probe-"));
}
