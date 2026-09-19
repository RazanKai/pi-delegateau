import type { DelegationMode } from "./types.js";
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
    constructor(surface: ModeToolSurface);
    setAllowedTools(mode: "delegate-execution" | "coordinator-only", tools: string[]): void;
    private currentPolicy;
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
