import type { DelegationMode } from "./types.js";
import { KNOWN_COORDINATION_TOOLS, MUTATION_TOOLS } from "./config.js";

export type RequestRestriction = "none" | "delegate" | "blocked";

// Model-visible tools while an enforced "delegate" restriction is active:
// delegation plus read/search coordination, never command/mutation tools.
const DELEGATE_GATE_TOOLS = new Set(["delegate_task", ...KNOWN_COORDINATION_TOOLS]);
// Model-visible tools while a "blocked" restriction is active. Status and
// recovery are handled by the /delegateau command and ordinary conversation;
// no model-facing execution tool is admitted.
const RECOVERY_TOOLS = new Set(["delegate_task"]);

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
        allowedTools: ["delegate_task", "read", "grep", "find", "ls"],
        prompt: "You coordinate and delegate. Use delegate_task for changes; direct commands and mutation are unavailable.",
      };
    case "coordinator-only":
      return {
        mode,
        enforced: true,
        allowedTools: ["delegate_task"],
        prompt: "You coordinate and delegate. Repository tools are unavailable; use delegate_task and talk to the user.",
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
  private requestBaseTools: string[] | undefined;
  private requestRestriction: RequestRestriction | undefined;

  constructor(private readonly surface: ModeToolSurface) {}

  setAllowedTools(mode: "delegate-execution" | "coordinator-only", tools: string[]): void {
    this.overrides[mode] = [...new Set(tools)];
  }

  private currentPolicy(): ModePolicy {
    const base = policyForMode(this.activeMode);
    const override = this.activeMode === "normal" ? undefined : this.overrides[this.activeMode];
    return override ? { ...base, allowedTools: override } : base;
  }

  baseToolNames(): string[] {
    if (this.activeMode === "normal") return this.requestBaseTools ? [...this.requestBaseTools] : [...this.surface.getActiveTools()];
    return [...(this.currentPolicy().allowedTools ?? [])];
  }

  private effectiveTools(): string[] {
    const base = this.activeMode === "normal"
      ? (this.requestBaseTools ? [...this.requestBaseTools] : [...this.surface.getActiveTools()])
      : [...(this.currentPolicy().allowedTools ?? [])];
    if (!this.requestRestriction || this.requestRestriction === "none") return base;
    const allowed = this.requestRestriction === "delegate" ? DELEGATE_GATE_TOOLS : RECOVERY_TOOLS;
    return base.filter((name) => allowed.has(name));
  }

  private applyTools(): void {
    this.surface.setActiveTools(this.effectiveTools());
  }

  setRequestRestriction(restriction: RequestRestriction): void {
    if (!this.requestBaseTools) this.requestBaseTools = [...this.surface.getActiveTools()];
    this.requestRestriction = restriction;
    this.applyTools();
  }

  clearRequestRestriction(): void {
    const base = this.requestBaseTools;
    this.requestBaseTools = undefined;
    this.requestRestriction = undefined;
    if (!base) return;
    if (this.activeMode === "normal") {
      this.surface.setActiveTools(base);
      return;
    }
    // Enforced mode still active: intersect the pre-restriction snapshot with
    // the enforced allowlist so clearing a request restriction can never
    // re-advertise tools the user's mode forbids (F06).
    this.applyModeAllowlist(base);
  }

  private applyModeAllowlist(base: string[]): void {
    const allowed = new Set(this.currentPolicy().allowedTools ?? []);
    const restored = base.filter((name) => allowed.has(name));
    this.surface.setActiveTools(restored);
  }

  requestRestrictionState(): RequestRestriction | undefined {
    return this.requestRestriction;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  activate(mode: DelegationMode): { ok: true } | { ok: false; reason: string } {
    if (this.busy) return { ok: false, reason: "busy" };
    if (mode === "normal") return this.deactivate();
    if (this.activeMode !== "normal") return { ok: false, reason: "mode already active" };
    // Capture the true normal-mode surface, never a restricted snapshot
    // (F06 poisoned-restore): if a request restriction is active, restore the
    // pre-restriction base before saving.
    this.savedTools = [...(this.requestBaseTools ?? this.surface.getActiveTools())];
    this.activeMode = mode;
    this.applyTools();
    return { ok: true };
  }

  deactivate(): { ok: true } | { ok: false; reason: string } {
    if (this.busy) return { ok: false, reason: "busy" };
    const saved = this.savedTools;
    this.activeMode = "normal";
    this.savedTools = undefined;
    if (saved) {
      const available = this.surface.getAllTools?.().map((tool) => tool.name);
      const restored = available ? saved.filter((name) => available.includes(name)) : saved;
      if (this.requestRestriction) {
        this.requestBaseTools = restored;
        this.applyTools();
      } else {
        this.surface.setActiveTools(restored);
      }
    }
    return { ok: true };
  }

  current(): DelegationMode {
    return this.activeMode;
  }

  guard(toolName: string): { block: true; reason: string } | undefined {
    const policy = this.currentPolicy();
    if (policy.enforced && !policy.allowedTools?.includes(toolName)) {
      return { block: true, reason: `Tool ${toolName} is not allowed in ${this.activeMode} mode` };
    }
    if (this.requestRestriction === "delegate" && !DELEGATE_GATE_TOOLS.has(toolName)) {
      return { block: true, reason: `Tool ${toolName} is blocked by the current delegation decision` };
    }
    if (this.requestRestriction === "blocked" && !RECOVERY_TOOLS.has(toolName)) {
      return { block: true, reason: `Tool ${toolName} is blocked while the delegation decision requires recovery` };
    }
    return undefined;
  }
}

export { DELEGATE_GATE_TOOLS, RECOVERY_TOOLS, MUTATION_TOOLS };