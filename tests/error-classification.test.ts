import { describe, expect, it } from "vitest";
import { APIError, APIConnectionError, APITimeoutError, AuthenticationError } from "@typesafe-ai/sdk";
import { ReceiptError, classifyError, classifyFailure } from "../src/receipts.js";

/**
 * The SDK's error classes carry the status. Classification must read that
 * structure rather than re-parsing a message, because a local deadline, a
 * provider timeout and a refused credential are three different failures —
 * and the local deadline is ours, not the provider's.
 */
describe("classifyFailure", () => {
  it("reads the local deadline as a timeout, not as an unknown sensor error", () => {
    const err = new Error("Delegation decision deadline exceeded");
    expect(classifyFailure(err)).toBe("timeout");
    expect(classifyFailure(new Error("Jev selection deadline exceeded"))).toBe("timeout");
  });

  it("reads a caller abort as cancelled", () => {
    const err = new Error("Delegation cancelled before launch");
    expect(classifyFailure(err)).toBe("cancelled");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyFailure(abort)).toBe("cancelled");
  });

  it("takes the code the SDK put on the error", () => {
    expect(classifyFailure(new ReceiptError("timeout", "TypeSafe request timed out"))).toBe("timeout");
    expect(classifyFailure(new ReceiptError("budget", "request limit reached"))).toBe("budget");
    expect(classifyFailure(new ReceiptError("connection", "socket closed"))).toBe("connection");
  });

  it("categorizes HTTP rejections by status, not by message text", () => {
    const headers = new Headers();
    expect(classifyFailure(new AuthenticationError(401, {}, headers))).toBe("credential-missing");
    expect(classifyFailure(new APIError(403, {}, headers))).toBe("sensing-prohibited");
    expect(classifyFailure(new APIError(422, {}, headers))).toBe("invalid-response");
    expect(classifyFailure(new APIError(429, {}, headers))).toBe("quota");
    expect(classifyFailure(new APIError(400, {}, headers))).toBe("invalid-response");
    // A 5xx is the provider failing, not us sending something wrong.
    expect(classifyFailure(new APIError(503, {}, headers))).toBe("sensor-error");
  });

  it("separates a provider timeout from a dropped connection", () => {
    expect(classifyFailure(new APITimeoutError(1_500))).toBe("timeout");
    expect(classifyFailure(new APIConnectionError("socket hang up"))).toBe("connection");
  });

  it("covers a message that arrives without structure", () => {
    // Older paths still hand over a bare message; those keep working.
    expect(classifyFailure(new Error("Something odd happened"))).toBe("sensor-error");
    expect(classifyFailure(undefined)).toBeUndefined();
  });

  it("keeps the message-only classifier for persisted text", () => {
    expect(classifyError("No API key was provided. Pass apiKey or set TYPESAFE_API_KEY.")).toBe("credential-missing");
    expect(classifyError("Delegation decision deadline exceeded")).toBe("timeout");
    expect(classifyError("some other failure")).toBe("sensor-error");
    expect(classifyError(undefined)).toBeUndefined();
  });
});
