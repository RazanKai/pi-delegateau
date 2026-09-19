import type { DelegationMode } from "./types.js";
import { MUTATION_TOOLS } from "./config.js";
export type RequestRestriction = "none" | "delegate" | "blocked";
declare const DELEGATE_GATE_TOOLS: Set<string>;
declare const RECOVERY_TOOLS: Set<string>;
export interface ModePolicy {
    mode: DelegationMode;
    enforced: boolean;
    allowedTools?: string[];
    prompt: string;
}
export declare function policyForMode(mode: DelegationMode): ModePolicy;
export interface ModeToolSurface {
    getActiveTools(): string[];
    setActiveTools(names: string[]): void;
    getAllTools?: () => Array<{
        name: string;
    }>;
}
export declare class ModeController {
    private readonly surface;
    private activeMode;
    private savedTools;
    private busy;
    private overrides;
    private requestBaseTools;
    private requestRestriction;
    constructor(surface: ModeToolSurface);
    setAllowedTools(mode: "delegate-execution" | "coordinator-only", tools: string[]): void;
    private currentPolicy;
    baseToolNames(): string[];
    private effectiveTools;
    private applyTools;
    setRequestRestriction(restriction: RequestRestriction): void;
    clearRequestRestriction(): void;
    private applyModeAllowlist;
    requestRestrictionState(): RequestRestriction | undefined;
    setBusy(busy: boolean): void;
    activate(mode: DelegationMode): {
        ok: true;
    } | {
        ok: false;
        reason: string;
    };
    deactivate(): {
        ok: true;
    } | {
        ok: false;
        reason: string;
    };
    current(): DelegationMode;
    guard(toolName: string): {
        block: true;
        reason: string;
    } | undefined;
}
export { DELEGATE_GATE_TOOLS, RECOVERY_TOOLS, MUTATION_TOOLS };
