import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DispatchAdmission } from "./admission.js";
import { HealthStore } from "./health-store.js";
import { type CandidateProfile, type ComplexityLevel, type DelegateConfig, type TrustedAgent } from "./types.js";
export interface AssignmentInput {
    agent: string;
    task: string;
    expectedOutput?: string;
    context?: string;
}
export declare class DispatchFailure extends Error {
    readonly payload: {
        text: string;
        details: Record<string, unknown>;
    };
    constructor(payload: {
        text: string;
        details: Record<string, unknown>;
    });
}
export interface ExecuteDispatchOptions {
    config: DelegateConfig;
    agent: TrustedAgent;
    assignment: AssignmentInput;
    ctx: ExtensionContext;
    pool: DispatchAdmission;
    signal?: AbortSignal;
    onUpdate?: (update: {
        content: Array<{
            type: "text";
            text: string;
        }>;
        details: Record<string, unknown>;
    }) => void;
    decisionId?: string;
    /** Difficulty the gate judged for this request, forwarded to the chooser. */
    complexity?: ComplexityLevel;
    /** Shared health store; one per `delegate_task` call so batch siblings see each other's trials. */
    health?: HealthStore;
    registerController: (controller: AbortController) => void;
    unregisterController: (controller: AbortController) => void;
    markDelegated: () => void;
}
export declare function executeDispatch(options: ExecuteDispatchOptions): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
}>;
export declare function validateAssignment(config: DelegateConfig, assignment: AssignmentInput): void;
export declare function validateConfiguredChildTools(agent: TrustedAgent): void;
export type { CandidateProfile };
