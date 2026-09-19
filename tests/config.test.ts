import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("configuration", () => {
  it("rejects duplicate candidate identities and non-finite limits", () => {
    expect(() => parseConfig({ candidates: [{ provider: "a", id: "x" }, { provider: "a", id: "x" }] })).toThrow(
      "Duplicate candidate",
    );
    expect(() => parseConfig({ limits: { selectionDeadlineMs: 0 } })).toThrow("selectionDeadlineMs");
  });

  it("defaults to safe normal fixed behavior and bounded limits", () => {
    expect(parseConfig({})).toMatchObject({ selection: "fixed", mode: "normal", preference: "balanced" });
    expect(parseConfig({}).limits.childOutputChars).toBeGreaterThan(0);
  });
});
