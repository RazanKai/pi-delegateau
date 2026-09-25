import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_TOOLS } from "./config.js";
import { resolveCandidateData } from "./live-data.js";
import type { HealthGate } from "./health.js";
import { providerQuotaExhausted, type QuotaState } from "./quota.js";
import { isKnownUnreachable, readProbeCache, type ProbeCache } from "./reachability.js";
import type { RouteExcludedCandidate, RouteExclusionReason } from "./route-trace.js";
import { modelKey, type CandidateProfile, type DelegateConfig, type ModelIdentity, type TrustedAgent } from "./types.js";

/**
 * One shared candidate-eligibility resolver for BOTH the delegation gate and the
 * dispatch path, so "a child is available" means exactly what dispatch can
 * launch. It folds together the hard filters that already existed (registry
 * presence, configured auth, quota floor, reachability, child-tool validity)
 * with the new runtime health circuit, and returns the excluded candidates with
 * stable reasons for the route trace.
 *
 * Health is applied HERE, before Jev: an open circuit's model never reaches the
 * chooser, which is the whole point of persisting the failure.
 */

export const DELEGATE_TOOL_NAME = "delegate_task";

export interface EligibleResolution {
  candidates: CandidateProfile[];
  excluded: RouteExcludedCandidate[];
}

export interface ResolveEligibleOptions {
  config: DelegateConfig;
  agent: TrustedAgent;
  ctx: ExtensionContext;
  quotaState?: QuotaState;
  health?: HealthGate;
  /** Overlay provider-registered metadata; the gate can skip this enrichment. */
  enrich?: boolean;
  now?: number;
  /** Injectable reachability source for deterministic tests. */
  probeCache?: ProbeCache | undefined;
  isUnreachable?: (identity: ModelIdentity) => boolean;
}

/** Whether an agent's configured child tools are structurally launchable at all. */
export function childToolsInvalid(agent: TrustedAgent): boolean {
  const hasExtensions = (agent.childExtensions?.length ?? 0) > 0;
  return agent.tools.some((tool) => tool === DELEGATE_TOOL_NAME || (!CHILD_TOOLS.has(tool) && !hasExtensions));
}

/** Overlay provider-registered cost/limits onto a configured candidate. */
function applyLiveData(candidate: CandidateProfile, ctx: ExtensionContext): CandidateProfile {
  try {
    const data = resolveCandidateData(candidate.identity, candidate, ctx.modelRegistry);
    return {
      ...candidate,
      ...(data.cost ? { cost: data.cost } : {}),
      costSource: data.costSource,
      ...(data.contextWindow !== undefined ? { contextWindow: data.contextWindow } : {}),
      ...(data.maxOutputTokens !== undefined ? { maxOutputTokens: data.maxOutputTokens } : {}),
      ...(data.reasoning !== undefined ? { reasoning: data.reasoning } : {}),
      ...(data.inputModalities ? { inputModalities: data.inputModalities } : {}),
    };
  } catch {
    // Provider data is an enhancement, never a launch prerequisite: a registry
    // that misbehaves must degrade to the configured profile, not fail dispatch.
    return candidate;
  }
}

function probeExcludes(identity: ModelIdentity, probeCache: ProbeCache | undefined): boolean {
  try {
    return isKnownUnreachable(identity, probeCache);
  } catch {
    return false;
  }
}

export function resolveEligibleCandidates(options: ResolveEligibleOptions): EligibleResolution {
  const { config, agent, ctx, quotaState, health, enrich = false } = options;
  const now = options.now ?? Date.now();
  const probeCache = "probeCache" in options ? options.probeCache : readProbeCache();
  const candidates: CandidateProfile[] = [];
  const excluded: RouteExcludedCandidate[] = [];
  const toolsInvalid = childToolsInvalid(agent);

  for (const candidate of config.candidates) {
    const id = modelKey(candidate.identity);
    const reasons: RouteExclusionReason[] = [];

    const model = ctx.modelRegistry.find(candidate.identity.provider, candidate.identity.id);
    if (!model) {
      reasons.push("not-in-registry");
    } else if (typeof ctx.modelRegistry.hasConfiguredAuth === "function" && !ctx.modelRegistry.hasConfiguredAuth(model)) {
      reasons.push("no-auth");
    }
    if (toolsInvalid) reasons.push("child-tools-invalid");
    const unreachable = options.isUnreachable
      ? options.isUnreachable(candidate.identity)
      : probeExcludes(candidate.identity, probeCache);
    if (unreachable) reasons.push("unreachable");
    if (providerQuotaExhausted(quotaState, candidate.identity.provider)) reasons.push("quota-exhausted");

    let openUntil: number | undefined;
    if (health) {
      const circuit = health.circuit(id, now);
      if (circuit.open) {
        reasons.push("circuit-open");
        openUntil = circuit.openUntil;
      } else if (circuit.trialActive) {
        reasons.push("trial-active");
      }
    }

    if (reasons.length > 0) {
      excluded.push({
        id,
        reasons,
        ...(openUntil !== undefined ? { openUntil: new Date(openUntil).toISOString() } : {}),
      });
      continue;
    }
    candidates.push(enrich ? applyLiveData(candidate, ctx) : candidate);
  }

  return { candidates, excluded };
}
