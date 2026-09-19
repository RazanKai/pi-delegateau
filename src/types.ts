export type SelectionMode = "fixed" | "jev";
export type DelegationMode = "normal" | "delegate-execution" | "coordinator-only";
export type DelegationPolicy = "manual" | "jev-suggest" | "jev-enforce";
export type RoutingPreference = "economy" | "balanced" | "quality";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelIdentity {
  provider: string;
  id: string;
}

export interface CandidateProfile {
  identity: ModelIdentity;
  description: string;
  capabilities: string[];
  limitations?: string[];
  provenance: "built-in" | "user";
  contextWindow?: number;
  /**
   * Per-1M-token prices. Where a value came from now matters as much as the
   * number: a config-authored figure is a guess by a human, while a
   * provider-registered figure is the live catalog's own data. `costSource`
   * records which, so a guessed price is never presented to the chooser as
   * authoritative.
   */
  cost?: { input?: number; output?: number; cacheRead?: number };
  costSource?: "provider" | "user";
  latencyMs?: number;
  maxOutputTokens?: number;
  /** Provider-declared reasoning capability, when known. */
  reasoning?: boolean;
  /** Provider-declared accepted input modalities, when known. */
  inputModalities?: string[];
}

/**
 * Complexity of the work, modelled on the six-level classification used by
 * subscription-aware routers (see pkg-research notes). An ordinal scale gives
 * the chooser a difficulty axis that a three-value cost/quality preference
 * cannot express: "balanced" says nothing about whether a rename or a
 * cross-service migration is being routed.
 */
export type ComplexityLevel = "trivial" | "simple" | "moderate" | "advanced" | "complex" | "frontier";

/** Thinking effort conventionally paired with each level. */
export const COMPLEXITY_EFFORT: Readonly<Record<ComplexityLevel, ThinkingLevel>> = {
  trivial: "minimal",
  simple: "low",
  moderate: "medium",
  advanced: "high",
  complex: "xhigh",
  frontier: "max",
};

export const COMPLEXITY_LEVELS: readonly ComplexityLevel[] = ["trivial", "simple", "moderate", "advanced", "complex", "frontier"];

/**
 * Bounded, non-source repository profile so the same request can rate
 * differently in a small app than in a monorepo. Never carries file contents
 * or conversation history.
 */
export interface RepositoryProfile {
  /** Top-level and second-level directory names (names only). */
  directories: string[];
  fileCount?: number;
  /** package.json name/scripts/dependency COUNT — never dependency contents. */
  manifest?: { name?: string; scriptNames: string[]; dependencyCount: number };
  /** Names of loaded context files (AGENTS.md/CLAUDE.md), not their contents. */
  contextFileNames: string[];
  /** True when the workspace is not a git repository. */
  nonGit?: boolean;
}

export interface TrustedAgent {
  name: string;
  instructions: string;
  tools: string[];
  childExtensions?: string[];
  model?: ModelIdentity;
}

export interface DelegateRequest {
  agent: TrustedAgent;
  task: string;
  expectedOutput?: string;
  context?: string;
  preference: RoutingPreference;
  /**
   * Difficulty judged by the gate for this same request. Supplied to the
   * chooser as a defined axis, because `preference` alone ("balanced") says
   * nothing about whether a rename or a cross-service migration is being routed.
   */
  complexity?: ComplexityLevel;
  candidates: CandidateProfile[];
  defaultModel?: ModelIdentity;
  selectionMode: SelectionMode;
  allowExternalSensing: boolean;
  selectionDeadlineMs?: number;
}

export interface JevChoiceInput {
  state: {
    task: string;
    expectedOutput?: string;
    context?: string;
    agent: { name: string; instructions: string; tools: string[] };
    preference: RoutingPreference;
    complexity?: ComplexityLevel;
    /** Thinking effort the gate's level implies, when a level is known. */
    suggestedEffort?: ThinkingLevel;
    candidates: CandidateProfile[];
  };
  candidateIds: string[];
  question: string;
  signal?: AbortSignal;
}

export interface JevChoiceAnswer {
  identity: ModelIdentity;
  probabilities?: Record<string, number>;
  confidence?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type SelectionSource = "pin" | "fixed" | "single-candidate" | "jev" | "fallback";

export interface SelectionResult {
  identity: ModelIdentity;
  source: SelectionSource;
  probabilities?: Record<string, number>;
  confidence?: number;
  usage?: JevChoiceAnswer["usage"];
  chooserLatencyMs?: number;
  cause?: string;
}

export interface ChildRequest {
  model: ModelIdentity;
  task: string;
  expectedOutput?: string;
  context?: string;
  instructions: string;
  tools: string[];
  extensionPaths?: string[];
  cwd: string;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  wallTimeMs?: number;
  maxTurns?: number;
  maxOutputChars?: number;
}

export type ChildEvent =
  | { type: "assistant"; text: string; model?: string; responseModel?: string; stopReason?: string; errorMessage?: string; usage?: ChildUsage }
  | { type: "progress"; text: string }
  | { type: "diagnostic"; text: string };

export interface ChildUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export type ChildStatus = "success" | "failed" | "cancelled" | "timed-out" | "limit-exceeded" | "launch-error";

export interface ChildResult {
  status: ChildStatus;
  output: string;
  appliedModel: ModelIdentity;
  requestedModel?: ModelIdentity;
  servedModel?: ModelIdentity;
  exitCode?: number;
  usage?: ChildUsage;
  error?: string;
  diagnostics: string[];
  observedExit: boolean;
  processStarted?: boolean;
  groupCleaned?: boolean;
  outputTruncated?: boolean;
}

export interface DelegateLimits {
  selectionDeadlineMs: number;
  childWallTimeMs: number;
  childMaxTurns: number;
  childOutputChars: number;
  maxTaskChars: number;
  maxContextChars: number;
  maxExpectedOutputChars: number;
  maxGatePromptChars: number;
  concurrency: number;
  maxQueueDepth: number;
}

export interface DelegateConfig {
  selection: SelectionMode;
  delegationDecision: DelegationPolicy;
  mode: DelegationMode;
  preference: RoutingPreference;
  candidates: CandidateProfile[];
  defaultModel?: ModelIdentity;
  agentPins: Record<string, ModelIdentity>;
  agents: Record<string, TrustedAgent>;
  allowExternalSensing: boolean;
  allowedParentTools: { delegateExecution: string[]; coordinatorOnly: string[] };
  limits: DelegateLimits;
  childThinking?: ThinkingLevel;
  /**
   * Per-provider cost-metering overrides. Normally unnecessary — the extension
   * detects a subscription vs an API key from the credential's shape — but needed
   * where the auth shape does not determine the plan: an Ollama subscription can
   * be the grandfathered GPU-time tier OR the credit-based tier, and only the
   * user knows which.
   */
  costMode?: {
    providers?: Record<string, "token" | "quota-gpu-time">;
    ollamaPlan?: "gpu-time" | "credits";
  };
  receiptPath?: string;
  decisionReceiptPath?: string;
  piCommand?: string;
}

export function modelKey(identity: ModelIdentity): string {
  return `${identity.provider}/${identity.id}`;
}

export function sameModel(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.provider === b.provider && a.id === b.id;
}