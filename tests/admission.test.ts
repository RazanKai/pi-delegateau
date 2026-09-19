import { describe, expect, it } from "vitest";
import { DispatchAdmission } from "../src/admission.js";

describe("dispatch admission", () => {
  it("admits one operation and releases on success or failure", async () => {
    const admission = new DispatchAdmission();
    const first = admission.acquire();
    expect(first.ok).toBe(true);
    expect(admission.acquire().ok).toBe(false);
    first.release();
    expect(admission.acquire().ok).toBe(true);
  });

  it("keeps admission closed when cleanup cannot confirm exit", () => {
    const admission = new DispatchAdmission();
    const first = admission.acquire();
    expect(first.ok).toBe(true);
    first.blocked("child exit not observed");
    expect(admission.acquire()).toMatchObject({ ok: false, reason: "child exit not observed" });
  });
});
