export class DispatchAdmission {
    state = "idle";
    blockedReason = "";
    acquire() {
        if (this.state !== "idle")
            return { ok: false, reason: this.blockedReason || "A delegation is already running" };
        this.state = "active";
        let settled = false;
        return {
            ok: true,
            release: () => {
                if (settled)
                    return;
                settled = true;
                if (this.state === "active")
                    this.state = "idle";
            },
            blocked: (reason) => {
                if (settled)
                    return;
                settled = true;
                this.state = "blocked";
                this.blockedReason = reason;
            },
        };
    }
    isBusy() {
        return this.state !== "idle";
    }
    reason() {
        return this.blockedReason || undefined;
    }
}
