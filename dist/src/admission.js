export class AdmissionError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "AdmissionError";
    }
}
/** Instance-local bounded slot pool with a single FIFO queue. */
export class DispatchAdmission {
    concurrency;
    maxQueueDepth;
    running = new Set();
    blocked = new Map();
    queue = [];
    constructor(concurrency = 3, maxQueueDepth = 20) {
        this.assertLimits(concurrency, maxQueueDepth);
        this.concurrency = concurrency;
        this.maxQueueDepth = maxQueueDepth;
    }
    configure(concurrency, maxQueueDepth) {
        this.assertLimits(concurrency, maxQueueDepth);
        if (concurrency === this.concurrency && maxQueueDepth === this.maxQueueDepth)
            return;
        if (this.running.size > 0 || this.blocked.size > 0 || this.queue.length > 0) {
            throw new AdmissionError("Cannot change delegation concurrency while slots or queue entries exist", "reconfigured");
        }
        this.concurrency = concurrency;
        this.maxQueueDepth = maxQueueDepth;
    }
    canAccept(count) {
        if (!Number.isInteger(count) || count < 1)
            return false;
        const freeSlots = Math.max(0, this.concurrency - this.running.size - this.blocked.size);
        const freeQueue = Math.max(0, this.maxQueueDepth - this.queue.length);
        return count <= freeSlots + freeQueue;
    }
    acquire(dispatchId, options = {}) {
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
        return new Promise((resolve, reject) => {
            const entry = {
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
    cancelQueuedWhere(predicate) {
        const matches = this.queue.filter((entry) => predicate(entry.dispatchId));
        for (const entry of matches)
            this.cancelQueued(entry);
        return matches.length;
    }
    status() {
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
    isBusy() {
        return this.running.size > 0 || this.blocked.size > 0 || this.queue.length > 0;
    }
    reason() {
        return this.blocked.values().next().value;
    }
    assertLimits(concurrency, maxQueueDepth) {
        if (!Number.isInteger(concurrency) || concurrency < 1)
            throw new Error("concurrency must be a positive integer");
        if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 0)
            throw new Error("maxQueueDepth must be a non-negative integer");
    }
    hasRoom() {
        return this.running.size + this.blocked.size < this.concurrency;
    }
    createLease(dispatchId) {
        let settled = false;
        return {
            dispatchId,
            settle: (blockedReason) => {
                if (settled)
                    return;
                settled = true;
                if (!this.running.delete(dispatchId))
                    return;
                if (blockedReason)
                    this.blocked.set(dispatchId, blockedReason);
                this.drain();
            },
        };
    }
    cancelQueued(entry) {
        if (entry.state !== "queued")
            return;
        entry.state = "cancelled";
        const index = this.queue.indexOf(entry);
        if (index >= 0)
            this.queue.splice(index, 1);
        entry.removeAbort();
        entry.reject(new AdmissionError("Delegation cancelled while queued", "cancelled"));
        this.notifyPositions();
    }
    drain() {
        while (this.hasRoom() && this.queue.length > 0) {
            const entry = this.queue.shift();
            if (entry.state !== "queued")
                continue;
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
    notifyPositions() {
        this.queue.forEach((entry, index) => entry.onPosition?.(index + 1));
    }
}
