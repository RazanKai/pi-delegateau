import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { CandidateProfile, ModelIdentity } from "./types.js";

/**
 * Cost metering resolution.
 *
 * WHY THIS EXISTS: API price per token is a good GENERAL trendline — a huge
 * model does cost more GPU time than a small one — but it is not always the axis
 * that runs out. Measured on this machine:
 *
 *   - OpenAI via ChatGPT/Codex subscription: token-metered, so per-token price IS
 *     proportional to the quota consumed.
 *   - Ollama on the grandfathered plan: meters GPU TIME by architecture.
 *     `/api/usage` reports `activity.cost = 0.00000` while the weekly window sits
 *     at 95.6%. There, `glm-5.3-flash` has HALF the published price of
 *     `deepseek-v4.1-flash` yet costs ~3.5x the quota.
 *   - Ollama on the NEW plan: $60/month of API credits, so price DOES track
 *     directly, exactly like a pay-as-you-go account.
 *   - OpenAI via API credits instead of a subscription: also price-tracked.
 *
 * So metering depends on HOW the provider was set up, which Pi already knows:
 * `Credential.type` is `"oauth"` for subscription logins and `"api_key"` for keys.
 * That is detectable without reading any secret — only the credential's shape.
 *
 * Design rules:
 *   1. API price is ALWAYS the baseline signal (the trendline the user asked for).
 *   2. A detected subscription overlays a quota axis on top of it.
 *   3. A measured multiplier refines the quota axis; without one, price remains
 *      the best available proxy and is labelled as such.
 *   4. Everything is re-resolved per dispatch, so adding a provider AFTER
 *      installing the extension is picked up with no restart.
 */

/**
 * How a provider account charges. Distinct from "is it a subscription": an
 * Ollama subscription can still be credit-based (the new plan), in which case
 * price tracks consumption and the token axis is correct.
 */
export type CostMode = "token" | "quota-gpu-time";

export interface CostModeResolution {
  mode: CostMode;
  /** Where the decision came from, so it is auditable rather than magic. */
  decidedBy: "config-override" | "detected-plan" | "detected-subscription" | "detected-api-key" | "default";
  /** Auth shape Pi reported, when it could be read. */
  authType?: "oauth" | "api_key";
  /** Human-readable explanation for status/receipts. */
  note: string;
}

/** Explicit per-provider overrides a user can set in config. */
export interface CostModeConfig {
  /** Force a mode for a provider. */
  providers?: Record<string, CostMode>;
  /** Ollama plan discriminator: "gpu-time" (grandfathered) or "credits" (new). */
  ollamaPlan?: "gpu-time" | "credits";
}

/** One provider quota bucket, normalized across provider-specific APIs. */
export interface ProviderQuotaWindow {
  name: string;
  usedFraction: number;
  remainingFraction: number;
  resetAfterSeconds?: number;
  resetAt?: string;
}

/** Live budget state for one provider account. */
export interface ProviderQuotaState {
  provider: string;
  windows: ProviderQuotaWindow[];
  source: "snapshot";
  observedAt?: string;
}

/** Provider-keyed quota state. Missing state means unknown, not unlimited. */
export type QuotaState = Record<string, ProviderQuotaState>;

/** A provider is not offered once any of its limiting windows has <= 2% left. */
export const DEFAULT_QUOTA_EXHAUSTION_FLOOR = 0.02;

/** Read only the credential's SHAPE. Never returns or logs key material. */
export function detectAuthType(provider: string): "oauth" | "api_key" | undefined {
  try {
    const credential = readStoredCredential(provider);
    if (!credential) return undefined;
    return credential.type === "oauth" ? "oauth" : "api_key";
  } catch {
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
export function detectOllamaPlan(usage: unknown): "gpu-time" | "credits" | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const data = usage as { activity?: { cost?: unknown }; limits?: unknown };
  const cost = data.activity?.cost;
  const hasQuotaBuckets = Boolean(data.limits && typeof data.limits === "object" && Object.keys(data.limits).length > 0);
  if (!hasQuotaBuckets) return undefined;
  if (typeof cost !== "string" && typeof cost !== "number") return undefined;
  const numeric = typeof cost === "number" ? cost : Number.parseFloat(cost);
  if (!Number.isFinite(numeric)) return undefined;
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
export function readOllamaUsageSnapshot(): unknown | undefined {
  try {
    const snapshotPath = path.join(getAgentDir(), "cache", "pi-ollama-cloud-link", "usage-snapshot.json");
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    // Accept both the wrapper ({data, ts}) and a bare usage document.
    const wrapped = (parsed as { data?: unknown }).data;
    return wrapped ?? parsed;
  } catch {
    return undefined;
  }
}

function finiteFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

function resetAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resetAt(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function unwrapSnapshot(raw: unknown): { data: unknown; observedAt?: string } {
  if (!raw || typeof raw !== "object") return { data: raw };
  const record = raw as { data?: unknown; ts?: unknown };
  const observedAt = typeof record.ts === "number" && Number.isFinite(record.ts)
    ? new Date(record.ts).toISOString()
    : undefined;
  return { data: record.data ?? raw, ...(observedAt ? { observedAt } : {}) };
}

/**
 * Normalize the two quota response shapes currently used by provider clients:
 * Ollama's `limits.<bucket>.usage` fraction and Codex's
 * `rate_limit.*_window.used_percent`. Unknown shapes stay unknown.
 */
export function parseProviderQuota(provider: string, raw: unknown): ProviderQuotaState | undefined {
  const unwrapped = unwrapSnapshot(raw);
  if (!unwrapped.data || typeof unwrapped.data !== "object") return undefined;
  const data = unwrapped.data as Record<string, unknown>;
  const windows: ProviderQuotaWindow[] = [];
  const limits = data.limits;
  if (limits && typeof limits === "object" && !Array.isArray(limits)) {
    for (const [name, value] of Object.entries(limits)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const bucket = value as Record<string, unknown>;
      const usedFraction = finiteFraction(bucket.usage);
      if (usedFraction === undefined) continue;
      const after = resetAfter(bucket.reset_after_seconds);
      const at = resetAt(bucket.reset_at);
      windows.push({
        name,
        usedFraction,
        remainingFraction: 1 - usedFraction,
        ...(after !== undefined ? { resetAfterSeconds: after } : {}),
        ...(at !== undefined ? { resetAt: at } : {}),
      });
    }
  }
  const rateLimit = data.rate_limit;
  if (rateLimit && typeof rateLimit === "object" && !Array.isArray(rateLimit)) {
    for (const [name, value] of Object.entries(rateLimit)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const window = value as Record<string, unknown>;
      const usedPercent = typeof window.used_percent === "number" && Number.isFinite(window.used_percent)
        ? Math.min(Math.max(window.used_percent, 0), 100)
        : undefined;
      if (usedPercent === undefined) continue;
      const after = resetAfter(window.reset_after_seconds);
      const at = resetAt(window.reset_at);
      windows.push({
        name,
        usedFraction: usedPercent / 100,
        remainingFraction: 1 - usedPercent / 100,
        ...(after !== undefined ? { resetAfterSeconds: after } : {}),
        ...(at !== undefined ? { resetAt: at } : {}),
      });
    }
  }
  if (windows.length === 0) return undefined;
  return { provider, windows, source: "snapshot", ...(unwrapped.observedAt ? { observedAt: unwrapped.observedAt } : {}) };
}

function snapshotProviderName(directoryName: string): string {
  if (directoryName === "pi-ollama-cloud-link") return "ollama-cloud";
  return directoryName.startsWith("pi-") ? directoryName.slice(3) : directoryName;
}

/**
 * Read provider-owned quota snapshots without making a network request. Each
 * provider extension may publish `quota-snapshot.json` or `usage-snapshot.json`
 * under its cache directory; the existing Ollama extension already publishes the
 * latter. A missing snapshot is explicitly unknown and never treated as budget.
 */
export function readQuotaState(agentDir = getAgentDir()): QuotaState {
  const state: QuotaState = {};
  const cacheDir = path.join(agentDir, "cache");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return state;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const provider = snapshotProviderName(entry.name);
    for (const filename of ["quota-snapshot.json", "usage-snapshot.json"]) {
      try {
        const filePath = path.join(cacheDir, entry.name, filename);
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const quota = parseProviderQuota(provider, parsed);
        if (quota) {
          state[provider] = quota;
          break;
        }
      } catch {
        // A provider cache is optional; continue to the next source/provider.
      }
    }
  }
  return state;
}

export function quotaForProvider(state: QuotaState | undefined, provider: string): ProviderQuotaState | undefined {
  return state?.[provider];
}

/** Any limiting window near its cap makes the provider ineligible. */
export function providerQuotaExhausted(
  state: QuotaState | undefined,
  provider: string,
  floor = DEFAULT_QUOTA_EXHAUSTION_FLOOR,
): boolean {
  return Boolean(state?.[provider]?.windows.some((window) => window.remainingFraction <= floor));
}

/** Filter hard-unlaunchable providers before a chooser sees the candidates. */
export function filterCandidatesByQuota<T extends { identity: ModelIdentity }>(
  candidates: T[],
  state: QuotaState | undefined,
  floor = DEFAULT_QUOTA_EXHAUSTION_FLOOR,
): T[] {
  return candidates.filter((candidate) => !providerQuotaExhausted(state, candidate.identity.provider, floor));
}

function percentRemaining(value: number): string {
  const rounded = Math.round(value * 1000) / 10;
  return `${rounded}%`;
}

/** Bounded pressure text for Jev; no state means no invented claim. */
export function describeProviderQuota(quota: ProviderQuotaState | undefined): string | undefined {
  if (!quota || quota.windows.length === 0) return undefined;
  const ordered = [...quota.windows].sort((a, b) => a.remainingFraction - b.remainingFraction);
  const tightest = ordered[0]!;
  const parts = ordered.map((window) => `${window.name} ${percentRemaining(window.remainingFraction)} remaining`);
  const reset = tightest.resetAfterSeconds !== undefined
    ? `, tightest resets in ${Math.round(tightest.resetAfterSeconds)}s`
    : tightest.resetAt
      ? `, tightest resets at ${tightest.resetAt}`
      : "";
  return `${quota.provider} quota headroom: ${parts.join(", ")}${reset}`;
}

/** Render only quota facts for providers represented in a candidate set. */
export function describeCandidateProviderQuota(
  candidates: Array<{ identity: ModelIdentity }>,
  state: QuotaState | undefined,
): string[] {
  const providers = [...new Set(candidates.map((candidate) => candidate.identity.provider))];
  return providers.map((provider) => describeProviderQuota(state?.[provider]) ?? `${provider} quota headroom unknown; do not assume unlimited`);
}

export function resolveCostMode(
  provider: string,
  config: CostModeConfig = {},
  detectedAuthType?: "oauth" | "api_key",
  /**
   * Ollama usage document. Omit to read the sibling package's snapshot; pass
   * `null` to assert "unreadable" explicitly (an omitted argument cannot express
   * that, since it is indistinguishable from "not supplied").
   */
  ollamaUsage?: unknown | null,
): CostModeResolution {
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
        note:
          detected === "credits"
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

// ---------------------------------------------------------------------------
// Measured quota multipliers (overlay on the price trendline)
// ---------------------------------------------------------------------------

/**
 * A measured quota multiplier: how much of the subscription budget one call of
 * this model consumes, relative to a baseline of 1.0. This is an OVERLAY on the
 * price trendline, not a replacement for it — price already captures most of the
 * shape, and a measurement refines the part it gets wrong.
 */
export interface QuotaMeasurement {
  model: string;
  provider: string;
  /** Relative quota units per call; baseline 1.0 = the cheapest measured model. */
  unitsPerCall: number;
  /** Only "measured" or "user-reported" are trusted; anything else is a guess. */
  source: "measured" | "user-reported";
  measuredAt: string;
  samples?: number;
}

export interface QuotaStore {
  version: 1;
  baselineModel?: string;
  measurements: QuotaMeasurement[];
}

export const QUOTA_STORE_VERSION = 1;

export function quotaStorePath(agentDir = getAgentDir()): string {
  return path.join(agentDir, "delegateau", "quota-costs.json");
}

export function readQuotaStore(filePath = quotaStorePath()): QuotaStore | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || raw.version !== QUOTA_STORE_VERSION || !Array.isArray(raw.measurements)) return undefined;
    return raw as QuotaStore;
  } catch {
    return undefined;
  }
}

export function writeQuotaStore(store: QuotaStore, filePath = quotaStorePath()): void {
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
export function measurementKey(id: string): string {
  return id.split(":")[0] ?? id;
}

export function quotaUnitsFor(
  identity: ModelIdentity,
  store: QuotaStore | undefined,
): { units: number; source: QuotaMeasurement["source"]; samples?: number } | undefined {
  if (!store) return undefined;
  const key = measurementKey(identity.id);
  const found = store.measurements.find((m) => m.provider === identity.provider && measurementKey(m.model) === key);
  return found
    ? { units: found.unitsPerCall, source: found.source, ...(found.samples !== undefined ? { samples: found.samples } : {}) }
    : undefined;
}

/**
 * What the chooser is told about a candidate's cost.
 *
 * On BOTH modes a price is reported, because price is a real trendline in both.
 * The quota mode ADDS a multiplier where one has been measured, which is what
 * corrects the cases price gets wrong.
 */
export interface CostSignal {
  mode: CostMode;
  price?: { input?: number; output?: number; cacheRead?: number };
  provenance: "provider-price" | "author-price" | "none";
  /** Quota-metered only: measured multiplier against the cheapest measured model. */
  quotaUnits?: number;
  quotaProvenance?: "measured" | "user-reported";
  /** True on a quota-metered provider with no measurement yet. */
  quotaUnmeasured?: boolean;
  decidedBy: CostModeResolution["decidedBy"];
}

export function resolveCostSignal(
  identity: ModelIdentity,
  candidate: Pick<CandidateProfile, "cost" | "costSource">,
  options: {
    quotaStore?: QuotaStore;
    costModeConfig?: CostModeConfig;
    authType?: "oauth" | "api_key";
    ollamaUsage?: unknown;
  } = {},
): CostSignal {
  const resolution = resolveCostMode(identity.provider, options.costModeConfig ?? {}, options.authType, options.ollamaUsage);
  const hasPrice = Boolean(candidate.cost && (candidate.cost.input !== undefined || candidate.cost.output !== undefined));
  const base = {
    mode: resolution.mode,
    ...(hasPrice ? { price: candidate.cost } : {}),
    provenance: hasPrice ? (candidate.costSource === "user" ? ("author-price" as const) : ("provider-price" as const)) : ("none" as const),
    decidedBy: resolution.decidedBy,
  };

  if (resolution.mode === "token") return base;

  const measured = quotaUnitsFor(identity, options.quotaStore);
  return measured
    ? { ...base, quotaUnits: measured.units, quotaProvenance: measured.source }
    : { ...base, quotaUnmeasured: true };
}

/**
 * Render a cost signal as one clause for the chooser's criteria string, kept
 * beside the resolution so wording and numbers cannot drift apart.
 */
export function describeCostSignal(signal: CostSignal): string {
  const priceText = signal.price
    ? [
        signal.price.input !== undefined ? `$${signal.price.input}/M in` : "",
        signal.price.output !== undefined ? `$${signal.price.output}/M out` : "",
      ].filter(Boolean).join(", ")
    : "";

  if (signal.mode === "token") {
    if (!priceText) return "price unknown";
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
