export function policyForMode(mode) {
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
export class ModeController {
    surface;
    activeMode = "normal";
    savedTools;
    busy = false;
    overrides = {};
    constructor(surface) {
        this.surface = surface;
    }
    setAllowedTools(mode, tools) {
        this.overrides[mode] = [...new Set(tools)];
    }
    currentPolicy() {
        const base = policyForMode(this.activeMode);
        const override = this.activeMode === "normal" ? undefined : this.overrides[this.activeMode];
        return override ? { ...base, allowedTools: override } : base;
    }
    setBusy(busy) {
        this.busy = busy;
    }
    activate(mode) {
        if (this.busy)
            return { ok: false, reason: "busy" };
        if (mode === "normal")
            return this.deactivate();
        if (this.activeMode !== "normal")
            return { ok: false, reason: "mode already active" };
        this.savedTools = [...this.surface.getActiveTools()];
        this.activeMode = mode;
        this.surface.setActiveTools(this.currentPolicy().allowedTools ?? []);
        return { ok: true };
    }
    deactivate() {
        if (this.busy)
            return { ok: false, reason: "busy" };
        const saved = this.savedTools;
        this.activeMode = "normal";
        this.savedTools = undefined;
        if (saved) {
            const available = this.surface.getAllTools?.().map((tool) => tool.name);
            this.surface.setActiveTools(available ? saved.filter((name) => available.includes(name)) : saved);
        }
        return { ok: true };
    }
    current() {
        return this.activeMode;
    }
    guard(toolName) {
        const policy = this.currentPolicy();
        if (!policy.enforced || policy.allowedTools?.includes(toolName))
            return undefined;
        return { block: true, reason: `Tool ${toolName} is not allowed in ${this.activeMode} mode` };
    }
}
