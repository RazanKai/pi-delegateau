import { randomUUID } from "node:crypto";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  CandidateProfile,
  ComplexityLevel,
  DelegationMode,
  DelegationPolicy,
  ModelIdentity,
  RepositoryProfile,
  RoutingPreference,
} from "./types.js";
import { COMPLEXITY_EFFORT, COMPLEXITY_LEVELS } from "./types.js";
import { describeCandidateProviderQuota, type QuotaState } from "./quota.js";
import { isComplexityLevel } from "./live-data.js";

export type GateRecommendation = "local" | "delegate";
export type GateRestriction = "none" | "delegate" | "blocked";
export type GateSource = "manual" | "policy-determined" | "jev" | "fallback" | "failed" | "user-override" | "cancelled";
export type GateStatus = "pending" | "manual" | "applied" | "fallback" | "blocked" | "cancelled";
export type ExecutionOutcome = "none" | "local" | "delegated" | "mixed";

export interface DelegationGateInput {
  prompt: string;
  policy: DelegationPolicy;
  baseMode: DelegationMode;
  baseTools: string[];
  preference: RoutingPreference;
  parent: { provider?: string; id?: string; capabilities: string[] };
  candidates: CandidateProfile[];
  childAvailable: boolean;
  childAgentNames: string[];
  /** Current provider budget facts; omitted providers are unknown. */
  providerQuota?: QuotaState;
  allowExternalSensing: boolean;
  deadlineMs: number;
  maxGatePromptChars: number;
  /** Bounded, non-source repository profile; rate the same request per repo. */
  repository?: RepositoryProfile;
  /** Bounded statement of what a wrong answer costs for this assignment. */
  failureCost?: string;
}

export interface DelegationChoiceInput {
  state: {
    prompt: string;
    parent: DelegationGateInput["parent"];
    baseMode: DelegationMode;
    baseTools: string[];
    preference: RoutingPreference;
    candidates: CandidateProfile[];
    childAvailable: boolean;
    childAgentNames: string[];
    providerQuota?: QuotaState;
    repository?: RepositoryProfile;
    failureCost?: string;
  };
  question: string;
  /** Question text for the complexity judgement, asked in the SAME call. */
  complexityQuestion: string;
  signal?: AbortSignal;
}

export interface DelegationChoiceAnswer {
  recommendation: GateRecommendation;
  /**
   * Difficulty of the work. Asked alongside the local-vs-delegate judgement so
   * one bounded sensing operation yields both — the chooser needs a difficulty
   * axis, and a three-value cost/quality preference cannot supply one.
   */
  complexity?: ComplexityLevel;
  confidence?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface DelegationChoiceRuntime {
  choose(input: DelegationChoiceInput): Promise<DelegationChoiceAnswer>;
}

export interface DelegationDecision {
  decisionId: string;
  generation: number;
  policy: DelegationPolicy;
  baseMode: DelegationMode;
  source: GateSource;
  status: GateStatus;
  restriction: GateRestriction;
  recommendation?: GateRecommendation;
  /** Difficulty judged in the same sensing call as the recommendation. */
  complexity?: ComplexityLevel;
  childAvailable: boolean;
  eligibleChildIds: string[];
  childAgentNames: string[];
  confidence?: number;
  usage?: DelegationChoiceAnswer["usage"];
  latencyMs?: number;
  reason?: string;
  override?: "local" | "delegate" | "manual";
  execution: ExecutionOutcome;
  invalidationReason?: string;
}

const DELEGATION_QUESTION =
  "Given this parent, the eligible child capabilities, the context requirements, and the user's policy, which permitted execution path is preferable after accounting for handoff cost?";

/**
 * Asked in the SAME TypeSafe call as the delegation question, so difficulty
 * costs no extra round trip and cannot drift from the judged request.
 */
const COMPLEXITY_QUESTION =
  "How difficult is this work in this repository? Judge the work itself, not the size of any single file.";

/** Criteria spelling out the ordinal scale so levels are not left to guesswork. */
const COMPLEXITY_CRITERIA: Readonly<Record<string, string>> = {
  trivial: "rename, typo, or version bump; no reasoning about behaviour",
  simple: "a focused change in one file with an obvious correct answer",
  moderate: "a contained bug or a multi-file feature within one subsystem",
  advanced: "a subsystem change or cross-cutting refactor",
  complex: "concurrency, data migration, or cross-service debugging",
  frontier: "greenfield architecture or a core rewrite",
};

function modelKey(identity: ModelIdentity): string {
  return `${identity.provider}/${identity.id}`;
}

function abortError(): Error {
  return Object.assign(new Error("The delegation decision was cancelled"), { name: "AbortError" });
}

function baseAllowsDelegate(input: DelegationGateInput): boolean {
  return input.childAvailable && input.baseTools.includes("delegate_task");
}

function baseAllowsLocal(input: DelegationGateInput): boolean {
  return input.baseMode === "normal";
}

function copyInput(input: DelegationGateInput): DelegationGateInput {
  return {
    ...input,
    baseTools: [...input.baseTools],
    parent: { ...input.parent, capabilities: [...input.parent.capabilities] },
    candidates: input.candidates.map((candidate) => ({
      ...candidate,
      identity: { ...candidate.identity },
      capabilities: [...candidate.capabilities],
      ...(candidate.limitations ? { limitations: [...candidate.limitations] } : {}),
    })),
    childAgentNames: [...input.childAgentNames],
    ...(input.providerQuota ? {
      providerQuota: Object.fromEntries(Object.entries(input.providerQuota).map(([provider, quota]) => [provider, {
        ...quota,
        windows: quota.windows.map((window) => ({ ...window })),
      }])),
    } : {}),
  };
}

export class DelegationGate {
  private generationCounter = 0;
  private active: { input: DelegationGateInput; decision: DelegationDecision; controller: AbortController; cancel: () => void } | undefined;
  private lastDecision: DelegationDecision | undefined;

  async ensure(input: DelegationGateInput, runtime?: DelegationChoiceRuntime): Promise<DelegationDecision> {
    // A materially different request replaces the active decision; an identical
    // request reuses it. Prompt text alone is not identity: policy and mode can
    // change between requests (F02-adjacent stale-generation reuse).
    const sameRequest =
      this.active &&
      this.active.input.prompt === input.prompt &&
      this.active.input.policy === input.policy &&
      this.active.input.baseMode === input.baseMode &&
      this.active.input.allowExternalSensing === input.allowExternalSensing &&
      this.active.input.childAvailable === input.childAvailable;
    if (this.active && sameRequest) return this.active.decision;
    if (this.active) this.invalidate("replaced by a new request");

    const copied = copyInput(input);
    // Bound the sensing prompt INSIDE the gate (F11): every caller path is
    // covered, and the truncation is disclosed to the sensor.
    if (copied.prompt.length > copied.maxGatePromptChars) {
      copied.prompt = `${copied.prompt.slice(0, copied.maxGatePromptChars)}\n[prompt truncated to ${copied.maxGatePromptChars} characters]`;
    }
    const decisionId = randomUUID();
    const generation = ++this.generationCounter;
    const controller = new AbortController();
    // The cancellation promise is only created lazily, once sensing actually
    // starts, so no path can leave an orphaned rejected promise behind (F02).
    let cancelPending: (() => void) | undefined;
    let cancelled: Promise<never> | undefined;
    const pending: DelegationDecision = {
      decisionId,
      generation,
      policy: copied.policy,
      baseMode: copied.baseMode,
      source: "manual",
      status: "pending",
      restriction: copied.policy === "jev-enforce" ? "blocked" : "none",
      childAvailable: copied.childAvailable,
      eligibleChildIds: copied.candidates.map((candidate) => modelKey(candidate.identity)),
      childAgentNames: [...copied.childAgentNames],
      execution: "none",
    };
    this.active = {
      input: copied,
      decision: pending,
      controller,
      cancel: () => {
        cancelPending?.();
        controller.abort();
      },
    };
    this.lastDecision = pending;

    const finish = (result: DelegationDecision): DelegationDecision => {
      if (!this.active || this.active.decision.decisionId !== decisionId) return this.lastDecision ?? result;
      this.active.decision = result;
      this.lastDecision = result;
      return result;
    };

    if (copied.policy === "manual") {
      return finish({ ...pending, status: "manual", source: "manual", restriction: "none" });
    }

    const delegateAllowed = baseAllowsDelegate(copied);
    const localAllowed = baseAllowsLocal(copied);
    if (!delegateAllowed) {
      if (localAllowed) {
        return finish({ ...pending, status: "applied", source: "policy-determined", recommendation: "local", restriction: "none", reason: "No usable delegated child is available" });
      }
      return finish({ ...pending, status: "blocked", source: "policy-determined", restriction: "blocked", reason: "The active base mode requires delegation but no usable child is available" });
    }

    // Hard policy first: an enforced base mode already requires delegation, so
    // the outcome is code-determined and no sensing is needed regardless of
    // disclosure settings (F09 sensing-precedence inversion).
    if (copied.baseMode !== "normal") {
      return finish({ ...pending, status: "applied", source: "policy-determined", recommendation: "delegate", restriction: "delegate", reason: "The active base mode already requires delegated execution" });
    }

    if (!copied.allowExternalSensing) {
      if (copied.policy === "jev-suggest") {
        return finish({ ...pending, status: "fallback", source: "fallback", restriction: "none", reason: "External sensing is prohibited; parent retains manual choice" });
      }
      return finish({ ...pending, status: "blocked", source: "failed", restriction: "blocked", reason: "External sensing is prohibited in enforced delegation mode" });
    }

    if (!runtime) {
      return finish({ ...pending, status: copied.policy === "jev-suggest" ? "fallback" : "blocked", source: copied.policy === "jev-suggest" ? "fallback" : "failed", restriction: copied.policy === "jev-suggest" ? "none" : "blocked", reason: "No delegation decision sensor is configured" });
    }

    const started = performance.now();
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      if (!cancelled) {
        cancelled = new Promise<never>((_, reject) => {
          cancelPending = () => reject(abortError());
        });
      }
      const answer = await Promise.race([
        runtime.choose({
          state: {
            prompt: copied.prompt,
            parent: { ...copied.parent, capabilities: [...copied.parent.capabilities] },
            baseMode: copied.baseMode,
            baseTools: [...copied.baseTools],
            preference: copied.preference,
            candidates: copied.candidates.map((candidate) => ({
              ...candidate,
              identity: { ...candidate.identity },
              capabilities: [...candidate.capabilities],
              ...(candidate.limitations ? { limitations: [...candidate.limitations] } : {}),
            })),
            childAvailable: copied.childAvailable,
            childAgentNames: [...copied.childAgentNames],
            ...(copied.providerQuota ? { providerQuota: copied.providerQuota } : {}),
            ...(copied.repository ? { repository: copied.repository } : {}),
            ...(copied.failureCost ? { failureCost: copied.failureCost } : {}),
          },
          question: DELEGATION_QUESTION,
          complexityQuestion: COMPLEXITY_QUESTION,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error("Delegation decision deadline exceeded")), copied.deadlineMs);
        }),
        cancelled,
      ]);
      if (!this.active || this.active.decision.decisionId !== decisionId || controller.signal.aborted) throw abortError();
      if (answer.recommendation !== "local" && answer.recommendation !== "delegate") throw new Error("Jev returned an invalid delegation recommendation");
      if (answer.recommendation === "delegate" && !delegateAllowed) throw new Error("Jev recommended delegation but no usable child is available");
      return finish({
        ...pending,
        status: "applied",
        source: "jev",
        recommendation: answer.recommendation,
        ...(answer.complexity ? { complexity: answer.complexity } : {}),
        restriction: copied.policy === "jev-enforce" && answer.recommendation === "delegate" ? "delegate" : "none",
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
        ...(answer.usage ? { usage: answer.usage } : {}),
        latencyMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.active?.decision.decisionId === decisionId && this.active.decision.source === "user-override") return this.active.decision;
      if (controller.signal.aborted || reason.includes("cancelled")) {
        return finish({ ...pending, status: "cancelled", source: "cancelled", restriction: copied.policy === "jev-enforce" ? "blocked" : "none", reason: "The request was cancelled" });
      }
      return finish({
        ...pending,
        status: copied.policy === "jev-suggest" ? "fallback" : "blocked",
        source: copied.policy === "jev-suggest" ? "fallback" : "failed",
        restriction: copied.policy === "jev-suggest" ? "none" : "blocked",
        reason,
        latencyMs: Math.round(performance.now() - started),
      });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (this.active?.decision.decisionId === decisionId) {
        this.active.cancel = () => {
          controller.abort();
        };
      }
    }
  }

  current(): DelegationDecision | undefined {
    return this.active?.decision;
  }

  markExecution(kind: "local" | "delegated"): void {
    if (!this.active) return;
    const current = this.active.decision.execution;
    const execution: ExecutionOutcome = current === "none" || current === kind ? kind : "mixed";
    this.active.decision = { ...this.active.decision, execution };
    this.lastDecision = this.active.decision;
  }

  override(kind: "local" | "delegate" | "manual"): DelegationDecision {
    if (!this.active) throw new Error("There is no active delegation decision to override");
    const input = this.active.input;
    if (kind === "delegate" && !baseAllowsDelegate(input)) throw new Error("Delegation override is unavailable because no eligible child can be launched");
    if (kind === "local" && !baseAllowsLocal(input)) throw new Error("Local override would widen the active base mode");
    this.active.controller.abort();
    this.active.cancel();
    const result: DelegationDecision = {
      ...this.active.decision,
      status: "applied",
      source: "user-override",
      ...(kind === "manual" ? {} : { recommendation: kind }),
      restriction: kind === "delegate" ? "delegate" : "none",
      override: kind,
      reason: `User override: ${kind}`,
    };
    this.active.decision = result;
    this.lastDecision = result;
    return result;
  }

  invalidate(reason: string): DelegationDecision | undefined {
    const active = this.active;
    if (!active) return undefined;
    active.controller.abort();
    active.cancel();
    const result: DelegationDecision = {
      ...active.decision,
      status: "cancelled",
      source: "cancelled",
      restriction: active.input.policy === "jev-enforce" ? "blocked" : "none",
      invalidationReason: reason,
      reason: `Decision invalidated: ${reason}`,
    };
    this.lastDecision = result;
    this.active = undefined;
    return result;
  }

  settle(): DelegationDecision | undefined {
    const result = this.active?.decision ?? this.lastDecision;
    this.active = undefined;
    return result;
  }
}

export interface JevDelegationClientLike {
  systemOne(request: unknown, options?: { signal?: AbortSignal; timeout?: number; retry?: { maxRetries: number } }): Promise<any>;
}

export class JevDelegationSelector implements DelegationChoiceRuntime {
  private readonly client: JevDelegationClientLike | undefined;
  private readonly timeoutMs: number;

  /**
   * The TypeSafe client is created lazily and defensively: a missing API key
   * or any other construction failure is surfaced as a normal choose() failure
   * (which the gate turns into fail-closed/fallback behavior) instead of a
   * constructor throw outside the gate's error boundary (F01).
   */
  constructor(options: { client?: JevDelegationClientLike; timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (options.client) {
      this.client = options.client;
      return;
    }
    try {
      this.client = new TypeSafeClient({ timeout: this.timeoutMs, retry: { maxRetries: 0 } });
    } catch {
      // Missing credentials or unusable transport: leave the client unset.
      // choose() then throws a typed error inside the gate's race, where the
      // gate's own fail-closed/fallback logic handles it.
      this.client = undefined;
    }
  }

  async choose(input: DelegationChoiceInput): Promise<DelegationChoiceAnswer> {
    if (!this.client) throw new Error("Delegation decision sensor is unavailable: no credentials or transport configured");
    const quotaFacts = describeCandidateProviderQuota(input.state.candidates, input.state.providerQuota);
    const quotaText = quotaFacts.length > 0
      ? ` Current live budget: ${quotaFacts.join("; ")}. Do not choose a provider whose budget is absent from the eligible candidates.`
      : " Current live budget is unknown; do not infer quota from price or provider name.";
    const criteria = {
      local: `Handle the request with the current parent; delegation is not worth its handoff cost.${quotaText}`,
      delegate: `Send the request to one eligible child; the child can provide a useful isolated execution path.${quotaText}`,
    };
    // One call, two questions: the local-vs-delegate judgement and the
    // difficulty rating. Asking both together keeps one bounded sensing
    // operation per request and guarantees the difficulty refers to exactly the
    // request the recommendation was made about.
    const response = await this.client.systemOne(
      {
        state: input.state,
        model: "jev-latest",
        questions: {
          recommendation: choice(input.question, criteria),
          complexity: choice(input.complexityQuestion, COMPLEXITY_CRITERIA),
        },
      },
      { ...(input.signal ? { signal: input.signal } : {}), timeout: this.timeoutMs, retry: { maxRetries: 0 } },
    );
    const answer = response?.answers?.recommendation;
    if (!answer || (answer.choice !== "local" && answer.choice !== "delegate")) throw new Error("Jev returned no valid delegation recommendation");
    const complexity = response?.answers?.complexity?.choice;
    const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : undefined;
    return {
      recommendation: answer.choice,
      // An unrecognised level is dropped rather than coerced: a bad rating must
      // not silently become a routing input. The chooser then falls back to its
      // own judgement without a difficulty hint.
      ...(isComplexityLevel(complexity) ? { complexity } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(response.usage ? { usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } } : {}),
    };
  }
}

export { DELEGATION_QUESTION };