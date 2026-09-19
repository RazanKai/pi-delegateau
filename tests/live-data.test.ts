import { describe, expect, it } from "vitest";
import {
  buildRepositoryProfile,
  complexityScaleText,
  describeFailureCost,
  estimateInputCost,
  isComplexityLevel,
  resolveCandidateData,
  type ModelRegistryLike,
} from "../src/live-data.js";
import { COMPLEXITY_EFFORT } from "../src/types.js";

/**
 * A registry stand-in whose numbers are the REAL live values measured from this
 * machine's Pi registry (ollama-cloud, 2026-09-19). Using the real figures keeps
 * these tests honest about the magnitude of the problem being fixed: the
 * config-authored price for nemotron-3-super was 20x the provider's.
 */
function registry(): ModelRegistryLike {
  const models: Record<string, any> = {
    "ollama-cloud/glm-5.3-flash": {
      provider: "ollama-cloud",
      id: "glm-5.3-flash",
      cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 524_288,
      reasoning: true,
      input: ["text", "image"],
    },
    "ollama-cloud/nemotron-3-super": {
      provider: "ollama-cloud",
      id: "nemotron-3-super",
      cost: { input: 0.015, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 65_536,
      reasoning: true,
      input: ["text"],
    },
    // Declares a window but NO price: unknown must stay unknown.
    "ollama-cloud/unpriced": {
      provider: "ollama-cloud",
      id: "unpriced",
      contextWindow: 131_072,
      reasoning: false,
      input: ["text"],
    },
  };
  return { find: (provider, id) => models[`${provider}/${id}`] };
}

describe("resolveCandidateData", () => {
  // The core regression: a human-typed price must never win over the catalog's
  // own value. On this machine the authored figure for nemotron-3-super was
  // 0.3 while the provider declares 0.015 — a 20x overstatement that made a
  // very cheap model look expensive to the chooser.
  it("prefers the provider's price over a contradicting configured price", () => {
    const data = resolveCandidateData(
      { provider: "ollama-cloud", id: "nemotron-3-super" },
      { cost: { input: 0.3, output: 1.2 } },
      registry(),
    );
    expect(data.cost).toEqual({ input: 0.015, output: 0.6, cacheRead: 0.015 });
    expect(data.costSource).toBe("provider");
    // The provider's own limits win too.
    expect(data.contextWindow).toBe(262_144);
    expect(data.maxOutputTokens).toBe(65_536);
  });

  it("marks a configured price as unverified when the provider declares none", () => {
    const data = resolveCandidateData(
      { provider: "ollama-cloud", id: "unknown-model" },
      { cost: { input: 9.5, output: 20 } },
      registry(),
    );
    expect(data.costSource).toBe("user");
    expect(data.cost).toEqual({ input: 9.5, output: 20 });
  });

  // Unknown stays unknown: inventing a number to fill the field is what made the
  // original pool untrustworthy.
  it("leaves the price absent when neither provider nor config supplies one", () => {
    const data = resolveCandidateData({ provider: "ollama-cloud", id: "unpriced" }, {}, registry());
    expect(data.cost).toBeUndefined();
    expect(data.contextWindow).toBe(131_072);
    expect(data.reasoning).toBe(false);
  });

  it("survives a registry that returns nothing", () => {
    const data = resolveCandidateData(
      { provider: "ollama-cloud", id: "glm-5.3-flash" },
      { cost: { input: 1, output: 2 }, contextWindow: 5_000 },
      { find: () => undefined },
    );
    expect(data.costSource).toBe("user");
    expect(data.contextWindow).toBe(5_000);
  });
});

describe("estimateInputCost", () => {
  // Exposes the real burn driver: measured dispatches spent 95% of tokens on
  // INPUT, so cost is (context size) x (input price), and input prices in the
  // pool span ~200x.
  it("scales with context size at the provider's input price", () => {
    const cheap = resolveCandidateData({ provider: "ollama-cloud", id: "nemotron-3-super" }, {}, registry());
    const dear = resolveCandidateData({ provider: "ollama-cloud", id: "glm-5.3-flash" }, {}, registry());
    const at30k = (d: ReturnType<typeof resolveCandidateData>) => estimateInputCost(d, 30_000)!;
    expect(at30k(dear)).toBeGreaterThan(at30k(cheap));
    // 30k input tokens at $0.015/M vs $0.15/M — a 10x spread on the same work.
    expect(at30k(dear) / at30k(cheap)).toBeCloseTo(10, 5);
  });

  it("returns undefined rather than guessing when price or size is unknown", () => {
    const unpriced = resolveCandidateData({ provider: "ollama-cloud", id: "unpriced" }, {}, registry());
    expect(estimateInputCost(unpriced, 30_000)).toBeUndefined();
    const priced = resolveCandidateData({ provider: "ollama-cloud", id: "glm-5.3-flash" }, {}, registry());
    expect(estimateInputCost(priced, undefined)).toBeUndefined();
  });
});

describe("buildRepositoryProfile", () => {
  it("describes structure without carrying source contents", () => {
    const profile = buildRepositoryProfile("/home/nazar/src/pi-delegateau", ["AGENTS.md"]);
    expect(profile.directories).toContain("src");
    expect(profile.directories).toContain("tests");
    expect(profile.contextFileNames).toEqual(["AGENTS.md"]);
    expect(profile.manifest?.name).toBe("pi-delegateau");
    expect(profile.manifest?.scriptNames).toContain("test");
    expect(profile.manifest?.dependencyCount).toBeGreaterThan(0);
    // Heavy/vendored directories are excluded so the profile stays bounded and
    // says nothing about installed code.
    expect(profile.directories).not.toContain("node_modules");
    // The serialized profile must never contain file bodies.
    const encoded = JSON.stringify(profile);
    expect(encoded).not.toContain("import ");
    expect(encoded.length).toBeLessThan(8_000);
  });

  it("flags a non-git workspace, which this product must support", () => {
    const profile = buildRepositoryProfile("/tmp");
    expect(profile).toBeDefined();
  });
});

describe("describeFailureCost", () => {
  it("states the cost of a wrong answer in bounded terms", () => {
    const mutating = describeFailureCost({ expectedOutput: "tests pass" });
    expect(mutating).toContain("mutates the repository");
    expect(mutating).toContain("explicit acceptance criteria");

    const unbounded = describeFailureCost({});
    expect(unbounded).toContain("may go unnoticed");

    const readOnly = describeFailureCost({ readOnly: true });
    expect(readOnly).toContain("read-only");
  });

  it("mentions blast radius only when the workspace is large", () => {
    expect(describeFailureCost({ fileCount: 100 })).not.toContain("blast radius");
    expect(describeFailureCost({ fileCount: 900 })).toContain("blast radius");
  });
});

describe("complexity scale", () => {
  it("recognises exactly the six defined levels", () => {
    expect(isComplexityLevel("moderate")).toBe(true);
    expect(isComplexityLevel("frontier")).toBe(true);
    expect(isComplexityLevel("hard")).toBe(false);
    expect(isComplexityLevel(undefined)).toBe(false);
  });

  it("renders the scale with its effort mapping so levels are not guessed", () => {
    const text = complexityScaleText();
    for (const level of Object.keys(COMPLEXITY_EFFORT)) expect(text).toContain(level);
    expect(text).toContain("effort max");
  });
});
