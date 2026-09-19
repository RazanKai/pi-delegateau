export type SelectionMode = "fixed" | "jev";
export type DelegationMode = "normal" | "delegate-execution" | "coordinator-only";
export type RoutingPreference = "economy" | "balanced" | "quality";
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
    cost?: {
        input?: number;
        output?: number;
    };
    latencyMs?: number;
}
export interface TrustedAgent {
    name: string;
    instructions: string;
    tools: string[];
    model?: ModelIdentity;
}
export interface DelegateRequest {
    agent: TrustedAgent;
    task: string;
    expectedOutput?: string;
    context?: string;
    preference: RoutingPreference;
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
        agent: {
            name: string;
            instructions: string;
            tools: string[];
        };
        preference: RoutingPreference;
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
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
    };
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
    cwd: string;
    signal?: AbortSignal;
    wallTimeMs?: number;
    maxTurns?: number;
    maxOutputChars?: number;
}
export type ChildEvent = {
    type: "assistant";
    text: string;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: ChildUsage;
} | {
    type: "progress";
    text: string;
} | {
    type: "diagnostic";
    text: string;
};
export interface ChildUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
}
export type ChildStatus = "success" | "failed" | "cancelled" | "timed-out" | "limit-exceeded" | "launch-error";
export interface ChildResult {
    status: ChildStatus;
    output: string;
    appliedModel: ModelIdentity;
    exitCode?: number;
    usage?: ChildUsage;
    error?: string;
    diagnostics: string[];
    observedExit: boolean;
}
export interface DelegateLimits {
    selectionDeadlineMs: number;
    childWallTimeMs: number;
    childMaxTurns: number;
    childOutputChars: number;
    maxTaskChars: number;
    maxContextChars: number;
}
export interface DelegateConfig {
    selection: SelectionMode;
    mode: DelegationMode;
    preference: RoutingPreference;
    candidates: CandidateProfile[];
    defaultModel?: ModelIdentity;
    agentPins: Record<string, ModelIdentity>;
    agents: Record<string, TrustedAgent>;
    allowExternalSensing: boolean;
    allowedParentTools: {
        delegateExecution: string[];
        coordinatorOnly: string[];
    };
    limits: DelegateLimits;
    receiptPath?: string;
}
export declare function modelKey(identity: ModelIdentity): string;
export declare function sameModel(a: ModelIdentity, b: ModelIdentity): boolean;
