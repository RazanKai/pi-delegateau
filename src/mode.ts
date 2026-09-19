import type { DelegationMode } from "./types.js";

export interface ModePolicy {
  mode: DelegationMode;
  enforced: boolean;
  allowedTools?: string[];
  prompt: string;
}

export function policyForMode(mode: DelegationMode): ModePolicy {
  switch (mode) {
    case "normal":
      return {
        mode,
        enforced: false,
        prompt: "You may delegate work when useful. Delegation is optional; the parent owns acceptance of child results.",
      };
    case "delegate-execution":
      return {
        mode,
        enforced: true,
        allowedTools: ["delegate_task", "read", "search"],
        prompt: "You coordinate and delegate. Use delegate_task for changes; direct commands and mutation are unavailable.",
      };
    case "coordinator-only":
      return {
        mode,
        enforced: true,
        allowedTools: ["delegate_task", "ask_user"],
        prompt: "You coordinate and delegate. Repository tools are unavailable; use delegate_task or ask_user.",
      };
  }
}

export interface ModeToolSurface {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  getAllTools?: () => Array<{ name: string }>;
}

export class ModeController {
  private activeMode: DelegationMode = "normal";
  private savedTools: string[] | undefined;
  private busy = false;
  private overrides: Partial<Record<"delegate-execution" | "coordinator-only", string[]>> = {};

  constructor(private readonly surface: ModeToolSurface) {}

  setAllowedTools(mode: "delegate-execution" | "coordinator-only", tools: string[]): void {
    this.overrides[mode] = [...new Set(tools)];
  }

  private currentPolicy(): ModePolicy {
    const base = policyForMode(this.activeMode);
    const override = this.activeMode === "normal" ? undefined : this.overrides[this.activeMode];
    return override ? { ...base, allowedTools: override } : base;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  activate(mode: DelegationMode): { ok: true } | { ok: false; reason: string } {
    if (this.busy) return { ok: false, reason: "busy" };
    if (mode === "normal") return this.deactivate();
    if (this.activeMode !== "normal") return { ok: false, reason: "mode already active" };
    this.savedTools = [...this.surface.getActiveTools()];
    this.activeMode = mode;
    this.surface.setActiveTools(this.currentPolicy().allowedTools ?? []);
    return { ok: true };
  }

  deactivate(): { ok: true } | { ok: false; reason: string } {
    if (this.busy) return { ok: false, reason: "busy" };
    const saved = this.savedTools;
    this.activeMode = "normal";
    this.savedTools = undefined;
    if (saved) {
      const available = this.surface.getAllTools?.().map((tool) => tool.name);
      this.surface.setActiveTools(available ? saved.filter((name) => available.includes(name)) : saved);
    }
    return { ok: true };
  }

  current(): DelegationMode {
    return this.activeMode;
  }

  guard(toolName: string): { block: true; reason: string } | undefined {
    const policy = this.currentPolicy();
    if (!policy.enforced || policy.allowedTools?.includes(toolName)) return undefined;
    return { block: true, reason: `Tool ${toolName} is not allowed in ${this.activeMode} mode` };
  }
}
