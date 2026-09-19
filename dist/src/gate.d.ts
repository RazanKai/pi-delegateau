import type { CandidateProfile, DelegationMode, DelegationPolicy, RoutingPreference } from "./types.js";
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
    parent: {
        provider?: string;
        id?: string;
        capabilities: string[];
    };
    candidates: CandidateProfile[];
    childAvailable: boolean;
    childAgentNames: string[];
    allowExternalSensing: boolean;
    deadlineMs: number;
    maxGatePromptChars: number;
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
    };
    question: string;
    signal?: AbortSignal;
}
export interface DelegationChoiceAnswer {
    recommendation: GateRecommendation;
    confidence?: number;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
    };
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
declare const DELEGATION_QUESTION = "Given this parent, the eligible child capabilities, the context requirements, and the user's policy, which permitted execution path is preferable after accounting for handoff cost?";
export declare class DelegationGate {
    private generationCounter;
    private active;
    private lastDecision;
    ensure(input: DelegationGateInput, runtime?: DelegationChoiceRuntime): Promise<DelegationDecision>;
    current(): DelegationDecision | undefined;
    markExecution(kind: "local" | "delegated"): void;
    override(kind: "local" | "delegate" | "manual"): DelegationDecision;
    invalidate(reason: string): DelegationDecision | undefined;
    settle(): DelegationDecision | undefined;
}
export interface JevDelegationClientLike {
    systemOne(request: unknown, options?: {
        signal?: AbortSignal;
        timeout?: number;
        retry?: {
            maxRetries: number;
        };
    }): Promise<any>;
}
export declare class JevDelegationSelector implements DelegationChoiceRuntime {
    private readonly client;
    private readonly timeoutMs;
    /**
     * The TypeSafe client is created lazily and defensively: a missing API key
     * or any other construction failure is surfaced as a normal choose() failure
     * (which the gate turns into fail-closed/fallback behavior) instead of a
     * constructor throw outside the gate's error boundary (F01).
     */
    constructor(options?: {
        client?: JevDelegationClientLike;
        timeoutMs?: number;
    });
    choose(input: DelegationChoiceInput): Promise<DelegationChoiceAnswer>;
}
export { DELEGATION_QUESTION };
