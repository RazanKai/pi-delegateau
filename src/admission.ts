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

export class AdmissionError extends Error {
  constructor(
    message: string,
    readonly code: "queue-full" | "cancelled" | "reconfigured",
  ) {
    super(message);
    this.name = "AdmissionError";
  }
}

interface QueuedEntry {
  dispatchId: string;
  signal?: AbortSignal;
  onPosition?: (position: number) => void;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: AdmissionError) => void;
  removeAbort: () => void;
  state: "queued" | "starting" | "cancelled";
}

/** Instance-local bounded slot pool with a single FIFO queue. */
export class DispatchAdmission {
  private concurrency: number;
  private maxQueueDepth: number;
  private readonly running = new Set<string>();
  private readonly blocked = new Map<string, string>();
  private queue: QueuedEntry[] = [];

  constructor(concurrency = 3, maxQueueDepth = 20) {
    this.assertLimits(concurrency, maxQueueDepth);
    this.concurrency = concurrency;
    this.maxQueueDepth = maxQueueDepth;
  }

  configure(concurrency: number, maxQueueDepth: number): void {
    this.assertLimits(concurrency, maxQueueDepth);
    if (concurrency === this.concurrency && maxQueueDepth === this.maxQueueDepth) return;
    if (this.running.size > 0 || this.blocked.size > 0 || this.queue.length > 0) {
      throw new AdmissionError("Cannot change delegation concurrency while slots or queue entries exist", "reconfigured");
    }
    this.concurrency = concurrency;
    this.maxQueueDepth = maxQueueDepth;
  }

  canAccept(count: number): boolean {
    if (!Number.isInteger(count) || count < 1) return false;
    const freeSlots = Math.max(0, this.concurrency - this.running.size - this.blocked.size);
    const freeQueue = Math.max(0, this.maxQueueDepth - this.queue.length);
    return count <= freeSlots + freeQueue;
  }

  acquire(
    dispatchId: string,
    options: { signal?: AbortSignal; onPosition?: (position: number) => void } = {},
  ): Promise<AdmissionLease> {
    if (options.signal?.aborted) {
      return Promise.reject(new AdmissionError("Delegation cancelled while queued", "cancelled"));
    }
    if (this.hasRoom()) {
      this.running.add(dispatchId);
      return Promise.resolve(this.createLease(dispatchId));
    }
    if (this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(new AdmissionError("Delegation queue is full", "queue-full"));
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const entry: QueuedEntry = {
        dispatchId,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onPosition ? { onPosition: options.onPosition } : {}),
        resolve,
        reject,
        removeAbort: () => undefined,
        state: "queued",
      };
      const cancel = () => this.cancelQueued(entry);
      if (options.signal) {
        options.signal.addEventListener("abort", cancel, { once: true });
        entry.removeAbort = () => options.signal?.removeEventListener("abort", cancel);
      }
      this.queue.push(entry);
      this.notifyPositions();
    });
  }

  cancelQueuedWhere(predicate: (dispatchId: string) => boolean): number {
    const matches = this.queue.filter((entry) => predicate(entry.dispatchId));
    for (const entry of matches) this.cancelQueued(entry);
    return matches.length;
  }

  status(): DispatchPoolStatus {
    return {
      concurrency: this.concurrency,
      running: this.running.size,
      blocked: this.blocked.size,
      occupied: this.running.size + this.blocked.size,
      queued: this.queue.length,
      maxQueueDepth: this.maxQueueDepth,
      blockedReasons: [...this.blocked.values()],
    };
  }

  isBusy(): boolean {
    return this.running.size > 0 || this.blocked.size > 0 || this.queue.length > 0;
  }

  reason(): string | undefined {
    return this.blocked.values().next().value;
  }

  private assertLimits(concurrency: number, maxQueueDepth: number): void {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
    if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 0) throw new Error("maxQueueDepth must be a non-negative integer");
  }

  private hasRoom(): boolean {
    return this.running.size + this.blocked.size < this.concurrency;
  }

  private createLease(dispatchId: string): AdmissionLease {
    let settled = false;
    return {
      dispatchId,
      settle: (blockedReason?: string) => {
        if (settled) return;
        settled = true;
        if (!this.running.delete(dispatchId)) return;
        if (blockedReason) this.blocked.set(dispatchId, blockedReason);
        this.drain();
      },
    };
  }

  private cancelQueued(entry: QueuedEntry): void {
    if (entry.state !== "queued") return;
    entry.state = "cancelled";
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    entry.removeAbort();
    entry.reject(new AdmissionError("Delegation cancelled while queued", "cancelled"));
    this.notifyPositions();
  }

  private drain(): void {
    while (this.hasRoom() && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.state !== "queued") continue;
      entry.state = "starting";
      entry.removeAbort();
      // Cancellation can win at the dequeue boundary. It never consumes a slot.
      if (entry.signal?.aborted) {
        entry.state = "cancelled";
        entry.reject(new AdmissionError("Delegation cancelled while queued", "cancelled"));
        continue;
      }
      this.running.add(entry.dispatchId);
      entry.resolve(this.createLease(entry.dispatchId));
    }
    this.notifyPositions();
  }

  private notifyPositions(): void {
    this.queue.forEach((entry, index) => entry.onPosition?.(index + 1));
  }
}
