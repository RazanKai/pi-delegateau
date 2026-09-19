import { describe, expect, it } from "vitest";
import { AdmissionError, DispatchAdmission } from "../src/admission.js";

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
}

describe("dispatch admission pool", () => {
  it("runs up to the configured limit and drains queued work FIFO with position updates", async () => {
    const admission = new DispatchAdmission(2, 3);
    const first = await admission.acquire("first");
    const second = await admission.acquire("second");
    const thirdPositions: number[] = [];
    const fourthPositions: number[] = [];
    const thirdPromise = admission.acquire("third", { onPosition: (position) => thirdPositions.push(position) });
    const fourthPromise = admission.acquire("fourth", { onPosition: (position) => fourthPositions.push(position) });

    expect(admission.status()).toMatchObject({ running: 2, queued: 2, blocked: 0 });
    expect(thirdPositions).toEqual([1, 1]);
    expect(fourthPositions).toEqual([2]);

    first.settle();
    const third = await thirdPromise;
    expect(third.dispatchId).toBe("third");
    expect(fourthPositions.at(-1)).toBe(1);
    expect(admission.status()).toMatchObject({ running: 2, queued: 1 });

    second.settle();
    const fourth = await fourthPromise;
    expect(fourth.dispatchId).toBe("fourth");
    third.settle();
    fourth.settle();
    expect(admission.status()).toMatchObject({ running: 0, queued: 0, occupied: 0 });
  });

  it("cancels queued work without starting it or leaking a slot", async () => {
    const admission = new DispatchAdmission(1, 2);
    const first = await admission.acquire("first");
    const controller = new AbortController();
    const queued = admission.acquire("queued", { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    expect(admission.status()).toMatchObject({ running: 1, queued: 0 });

    first.settle();
    const later = await admission.acquire("later");
    expect(later.dispatchId).toBe("later");
    later.settle();
  });

  it("blocks only the degraded slot and settles every lease exactly once", async () => {
    const admission = new DispatchAdmission(2, 2);
    const bad = await admission.acquire("bad");
    const healthy = await admission.acquire("healthy");
    const queued = admission.acquire("queued");

    bad.settle("child exit not observed");
    bad.settle();
    await nextMicrotask();
    expect(admission.status()).toMatchObject({ running: 1, blocked: 1, queued: 1, occupied: 2 });
    healthy.settle();
    const promoted = await queued;
    expect(admission.status()).toMatchObject({ running: 1, blocked: 1, queued: 0 });
    promoted.settle();
    expect(admission.status()).toMatchObject({ running: 0, blocked: 1, occupied: 1 });
  });

  it("rejects overflow and reconfiguration while occupied", async () => {
    const admission = new DispatchAdmission(1, 1);
    const first = await admission.acquire("first");
    const queued = admission.acquire("queued");
    await expect(admission.acquire("overflow")).rejects.toEqual(expect.objectContaining<Partial<AdmissionError>>({ code: "queue-full" }));
    expect(() => admission.configure(2, 1)).toThrow("Cannot change");
    first.settle();
    (await queued).settle();
    admission.configure(2, 1);
    expect(admission.status().concurrency).toBe(2);
  });
});
