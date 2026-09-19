import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
/** Read only the credential's SHAPE. Never returns or logs key material. */
export function detectAuthType(provider) {
    try {
        const credential = readStoredCredential(provider);
        if (!credential)
            return undefined;
        return credential.type === "oauth" ? "oauth" : "api_key";
    }
    catch {
        return undefined;
    }
}
/**
 * Detect an Ollama plan from the account's own telemetry rather than guessing.
 *
 * Measured: the grandfathered plan returns `activity.cost == 0.00000` while
 * carrying 5h/weekly quota buckets — usage is metered as GPU time, not dollars.
 * A credit-based plan would show real dollar spend, because its usage IS priced.
 *
 * This is the discriminator that credential shape cannot provide: both plans
 * authenticate with an `api_key`, so `detectAuthType` reports "api_key" for
 * either, and only the account data distinguishes them.
 *
 * Returns undefined when the account cannot be read — unmeasured stays unknown,
 * and the caller falls back to the user's configured plan.
 */
export function detectOllamaPlan(usage) {
    if (!usage || typeof usage !== "object")
        return undefined;
    const data = usage;
    const cost = data.activity?.cost;
    const hasQuotaBuckets = Boolean(data.limits && typeof data.limits === "object" && Object.keys(data.limits).length > 0);
    if (!hasQuotaBuckets)
        return undefined;
    if (typeof cost !== "string" && typeof cost !== "number")
        return undefined;
    const numeric = typeof cost === "number" ? cost : Number.parseFloat(cost);
    if (!Number.isFinite(numeric))
        return undefined;
    // Zero dollar cost alongside quota buckets = GPU-time metering.
    return numeric === 0 ? "gpu-time" : "credits";
}
/**
 * Read the Ollama usage data Pi's sibling package caches to disk.
 *
 * The sibling (`pi-ollama-cloud-link`) refreshes `/api/usage` on startup and
 * snapshots the last good response. Reading that snapshot is preferred to making
 * our own call: it costs nothing, needs no credential handling here, and cannot
 * disagree with what the status bar shows.
 *
 * IMPORTANT LIMITATION: the snapshot only exists once that package has fetched
 * during a session, so on a cold start this returns undefined and plan detection
 * is unavailable. That is why the config override exists and why a wrong
 * guess here is only ever a fallback, not a silent default.
 */
export function readOllamaUsageSnapshot() {
    try {
        const snapshotPath = path.join(getAgentDir(), "cache", "pi-ollama-cloud-link", "usage-snapshot.json");
        const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        if (!parsed || typeof parsed !== "object")
            return undefined;
        // Accept both the wrapper ({data, ts}) and a bare usage document.
        const wrapped = parsed.data;
        return wrapped ?? parsed;
    }
    catch {
        return undefined;
    }
}
export function resolveCostMode(provider, config = {}, detectedAuthType, 
/**
 * Ollama usage document. Omit to read the sibling package's snapshot; pass
 * `null` to assert "unreadable" explicitly (an omitted argument cannot express
 * that, since it is indistinguishable from "not supplied").
 */
ollamaUsage) {
    // 1. Explicit config wins over everything, because only the user knows their plan.
    const override = config.providers?.[provider];
    if (override) {
        return { mode: override, decidedBy: "config-override", note: `Set explicitly in configuration.` };
    }
    if (provider === "ollama-cloud") {
        // 2. The plan discriminator is narrower and more honest than forcing a mode.
        if (config.ollamaPlan === "credits") {
            return {
                mode: "token",
                decidedBy: "config-override",
                note: "Ollama configured as the credit-based plan; published prices track consumption directly.",
            };
        }
        if (config.ollamaPlan === "gpu-time") {
            return {
                mode: "quota-gpu-time",
                decidedBy: "config-override",
                note: "Ollama configured as the grandfathered plan; quota is GPU time, set by architecture.",
            };
        }
        // 3. Otherwise ask the account itself.
        const detected = detectOllamaPlan(ollamaUsage === undefined ? readOllamaUsageSnapshot() : ollamaUsage);
        if (detected) {
            return {
                mode: detected === "credits" ? "token" : "quota-gpu-time",
                decidedBy: "detected-plan",
                note: detected === "credits"
                    ? "Detected a credit-based Ollama plan from account spend data; published prices track consumption."
                    : "Detected the grandfathered Ollama plan: account cost is zero while quota buckets are active, so usage is GPU time set by architecture.",
            };
        }
    }
    // 4. Non-Ollama providers: auth shape is the discriminator.
    const authType = detectedAuthType ?? detectAuthType(provider);
    if (authType === "oauth") {
        return {
            mode: "token",
            decidedBy: "detected-subscription",
            authType,
            note: "Subscription login that bills by tokens; published prices track consumption.",
        };
    }
    if (authType === "api_key") {
        return {
            mode: "token",
            decidedBy: "detected-api-key",
            authType,
            note: "API-key credential, billed per token (pay-as-you-go or credit balance).",
        };
    }
    return {
        mode: "token",
        decidedBy: "default",
        note: "No credential found for this provider yet; assuming per-token billing until one is configured.",
    };
}
export const QUOTA_STORE_VERSION = 1;
export function quotaStorePath(agentDir = getAgentDir()) {
    return path.join(agentDir, "delegateau", "quota-costs.json");
}
export function readQuotaStore(filePath = quotaStorePath()) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!raw || raw.version !== QUOTA_STORE_VERSION || !Array.isArray(raw.measurements))
            return undefined;
        return raw;
    }
    catch {
        return undefined;
    }
}
export function writeQuotaStore(store, filePath = quotaStorePath()) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
}
/**
 * The key a measurement is stored under.
 *
 * DELIBERATELY NARROW: only a dated tag is stripped (`deepseek-v4-flash:0731` ->
 * `deepseek-v4-flash`), because those ids are documented compatibility ALIASES
 * routing to the same model. Qualifier suffixes are NOT stripped: `glm-5.3` vs
 * `glm-5.3-flash`, and `luna`/`sol`/`terra`, are different architectures, and
 * architecture is what decides GPU-time cost. A sibling's measurement is
 * therefore not inherited — assuming that would be an inference, not a
 * measurement.
 */
export function measurementKey(id) {
    return id.split(":")[0] ?? id;
}
export function quotaUnitsFor(identity, store) {
    if (!store)
        return undefined;
    const key = measurementKey(identity.id);
    const found = store.measurements.find((m) => m.provider === identity.provider && measurementKey(m.model) === key);
    return found
        ? { units: found.unitsPerCall, source: found.source, ...(found.samples !== undefined ? { samples: found.samples } : {}) }
        : undefined;
}
export function resolveCostSignal(identity, candidate, options = {}) {
    const resolution = resolveCostMode(identity.provider, options.costModeConfig ?? {}, options.authType, options.ollamaUsage);
    const hasPrice = Boolean(candidate.cost && (candidate.cost.input !== undefined || candidate.cost.output !== undefined));
    const base = {
        mode: resolution.mode,
        ...(hasPrice ? { price: candidate.cost } : {}),
        provenance: hasPrice ? (candidate.costSource === "user" ? "author-price" : "provider-price") : "none",
        decidedBy: resolution.decidedBy,
    };
    if (resolution.mode === "token")
        return base;
    const measured = quotaUnitsFor(identity, options.quotaStore);
    return measured
        ? { ...base, quotaUnits: measured.units, quotaProvenance: measured.source }
        : { ...base, quotaUnmeasured: true };
}
/**
 * Render a cost signal as one clause for the chooser's criteria string, kept
 * beside the resolution so wording and numbers cannot drift apart.
 */
export function describeCostSignal(signal) {
    const priceText = signal.price
        ? [
            signal.price.input !== undefined ? `$${signal.price.input}/M in` : "",
            signal.price.output !== undefined ? `$${signal.price.output}/M out` : "",
        ].filter(Boolean).join(", ")
        : "";
    if (signal.mode === "token") {
        if (!priceText)
            return "price unknown";
        return signal.provenance === "author-price"
            ? `${priceText} (author-declared, unverified; per-token billing)`
            : `${priceText} (per-token billing)`;
    }
    // Quota-metered: price is still useful as a trendline, but the multiplier is
    // what actually predicts consumption, so it leads.
    const priceAsTrend = priceText ? `; published price ${priceText} is only a rough trendline here` : "";
    if (signal.quotaUnits !== undefined) {
        const label = signal.quotaProvenance === "measured" ? "measured" : "user-reported";
        return signal.quotaUnits === 1
            ? `uses the least quota of any model here (${label}${priceAsTrend})`
            : `costs about ${signal.quotaUnits}x the cheapest model in quota (${label}${priceAsTrend})`;
    }
    return `quota cost not yet measured on this plan; treat the published price as a rough trendline only${priceText ? ` (${priceText})` : ""}`;
}
