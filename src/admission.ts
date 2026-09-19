export interface AdmissionLease {
  readonly ok: true;
  release(): void;
  blocked(reason: string): void;
}

export interface AdmissionBusy {
  readonly ok: false;
  readonly reason: string;
}

export class DispatchAdmission {
  private state: "idle" | "active" | "blocked" = "idle";
  private blockedReason = "";

  acquire(): AdmissionLease | AdmissionBusy {
    if (this.state !== "idle") return { ok: false, reason: this.blockedReason || "A delegation is already running" };
    this.state = "active";
    let settled = false;
    return {
      ok: true,
      release: () => {
        if (settled) return;
        settled = true;
        if (this.state === "active") this.state = "idle";
      },
      blocked: (reason: string) => {
        if (settled) return;
        settled = true;
        this.state = "blocked";
        this.blockedReason = reason;
      },
    };
  }

  isBusy(): boolean {
    return this.state !== "idle";
  }

  reason(): string | undefined {
    return this.blockedReason || undefined;
  }
}
