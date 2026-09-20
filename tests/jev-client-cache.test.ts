import { afterEach, describe, expect, it } from "vitest";
import { JevSelector } from "../src/jev.js";
import { resetJevClientCache, sharedJevClient } from "../src/jev-client.js";

afterEach(() => {
  resetJevClientCache();
  delete process.env.TYPESAFE_API_KEY;
});

describe("shared Jev client", () => {
  it("returns the same instance for repeated constructions at one timeout", () => {
    process.env.TYPESAFE_API_KEY = "test-key-for-cache";
    const first = sharedJevClient(2_000);
    const second = sharedJevClient(2_000);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("keeps a separate client per timeout, since the deadline is baked in", () => {
    process.env.TYPESAFE_API_KEY = "test-key-for-cache";
    const fast = sharedJevClient(2_000);
    const slow = sharedJevClient(10_000);
    expect(fast).not.toBe(slow);
  });

  it("does not pin credentials captured before a key existed", () => {
    delete process.env.TYPESAFE_API_KEY;
    const withoutKey = sharedJevClient(2_000);
    process.env.TYPESAFE_API_KEY = "key-added-later";
    resetJevClientCache();
    const withKey = sharedJevClient(2_000);
    // A cache built while the key was missing must not be reused after one appears.
    expect(withoutKey).toBeUndefined();
    expect(withKey).toBeDefined();
  });

  it("reuses one client across many per-dispatch selectors", () => {
    process.env.TYPESAFE_API_KEY = "test-key-for-cache";
    // The shape that used to construct a client per delegation decision.
    const selectors = Array.from({ length: 25 }, () => new JevSelector({ timeoutMs: 2_000 }));
    const clients = selectors.map((selector) => (selector as unknown as { client: unknown }).client);
    expect(clients.every((client) => client !== undefined)).toBe(true);
    expect(new Set(clients).size).toBe(1);
  });

  it("still reports an unavailable sensor rather than throwing at construction", () => {
    delete process.env.TYPESAFE_API_KEY;
    const selector = new JevSelector({ timeoutMs: 2_000 });
    expect(() => new JevSelector({ timeoutMs: 2_000 })).not.toThrow();
    return expect(selector.choose({ state: { candidates: [] } } as never)).rejects.toThrow(
      /sensor is unavailable/,
    );
  });

  it("leaves an injected client untouched", () => {
    const injected = { systemOne: async () => ({}) };
    const selector = new JevSelector({ client: injected, timeoutMs: 2_000 });
    expect((selector as unknown as { client: unknown }).client).toBe(injected);
  });
});
