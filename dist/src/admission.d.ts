export interface DispatchPoolStatus {
    concurrency: number;
    running: number;
    blocked: number;
    occupied: number;
    queued: number;
    maxQueueDepth: number;
    blockedReasons: string[];
}
export interface AdmissionLease {
    readonly dispatchId: string;
    /** The only operation that releases or degrades an occupied slot. Idempotent. */
    settle(blockedReason?: string): void;
}
export declare class AdmissionError extends Error {
    readonly code: "queue-full" | "cancelled" | "reconfigured";
    constructor(message: string, code: "queue-full" | "cancelled" | "reconfigured");
}
/** Instance-local bounded slot pool with a single FIFO queue. */
export declare class DispatchAdmission {
    private concurrency;
    private maxQueueDepth;
    private readonly running;
    private readonly blocked;
    private queue;
    constructor(concurrency?: number, maxQueueDepth?: number);
    configure(concurrency: number, maxQueueDepth: number): void;
    canAccept(count: number): boolean;
    acquire(dispatchId: string, options?: {
        signal?: AbortSignal;
        onPosition?: (position: number) => void;
    }): Promise<AdmissionLease>;
    cancelQueuedWhere(predicate: (dispatchId: string) => boolean): number;
    status(): DispatchPoolStatus;
    isBusy(): boolean;
    reason(): string | undefined;
    private assertLimits;
    private hasRoom;
    private createLease;
    private cancelQueued;
    private drain;
    private notifyPositions;
}
