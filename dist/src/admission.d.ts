export interface AdmissionLease {
    readonly ok: true;
    release(): void;
    blocked(reason: string): void;
}
export interface AdmissionBusy {
    readonly ok: false;
    readonly reason: string;
}
export declare class DispatchAdmission {
    private state;
    private blockedReason;
    acquire(): AdmissionLease | AdmissionBusy;
    isBusy(): boolean;
    reason(): string | undefined;
}
