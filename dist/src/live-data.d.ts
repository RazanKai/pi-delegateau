import { type CandidateProfile, type ComplexityLevel, type ModelIdentity, type RepositoryProfile } from "./types.js";
/**
 * Live provider-data resolution.
 *
 * WHY THIS EXISTS: the chooser's only per-model signal used to be a prose
 * `description` typed by a human, plus hand-written prices. Measured on this
 * machine, those hand-written prices were wrong for 9 of 12 candidates (one
 * input price overstated 20x, others understated by up to 75%). Jev was
 * therefore routing on invented numbers.
 *
 * The provider already publishes the truth: Pi's model registry is populated by
 * the provider extension (pi-ollama-cloud-link calls `ctx.modelRegistry` cost
 * data from the live catalog) and each entry carries `{input, output,
 * cacheRead, cacheWrite}` per 1M tokens plus contextWindow/maxTokens/reasoning/
 * input modalities. Reading that registry is the whole fix: no duplicated price
 * table, no sibling-package import (that package has no exports map and Pi
 * loads packages with separate module roots, so importing it is not available).
 */
/** The subset of a Pi registry model this module relies on. */
export interface RegistryModelLike {
    provider?: string;
    id?: string;
    cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: string[];
}
export interface ModelRegistryLike {
    find(provider: string, id: string): RegistryModelLike | undefined;
    hasConfiguredAuth?(model: RegistryModelLike): boolean;
}
export interface ResolvedCandidateData {
    cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
    };
    costSource: "provider" | "user";
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
    inputModalities?: string[];
}
/**
 * Resolve one candidate against provider data.
 *
 * Precedence is deliberate and one-directional: provider-registered data WINS
 * over user-authored config, because the config figure is a human guess and the
 * registry figure is the catalog's own. A user value survives only where the
 * provider declares nothing, and is then marked `costSource: "user"` so the
 * chooser is told the number is unverified.
 */
export declare function resolveCandidateData(identity: ModelIdentity, configured: Pick<CandidateProfile, "cost" | "contextWindow">, registry: ModelRegistryLike | undefined): ResolvedCandidateData;
/**
 * Estimate the input cost of a dispatch at a given context size. This is what
 * exposes the real burn: measured dispatches spent 95% of their tokens on
 * INPUT, so the driver is (context size) x (input price), and input prices in
 * the pool span ~200x. Returns undefined when price or size is unknown.
 */
export declare function estimateInputCost(data: ResolvedCandidateData, inputTokens: number | undefined): number | undefined;
/**
 * Build a bounded, non-source repository profile.
 *
 * Contains directory NAMES, a file count, safe manifest metadata (name, script
 * names, dependency count) and the names of loaded context files. It never
 * reads source bodies or conversation history, and it is truncated by
 * construction rather than by a downstream cap.
 */
export declare function buildRepositoryProfile(cwd: string, contextFileNames?: string[]): RepositoryProfile;
/**
 * Cost of a wrong answer, stated in bounded terms the chooser can act on.
 * This is the second half of `expected cost = token cost + P(failure) x cost of
 * failure`: a cheap-but-weak model is a bad choice for a migration and a fine
 * choice for a rename, and the chooser can only know that if we say so.
 */
export interface FailureCostInputs {
    /** Parent's stated acceptance criteria, already bounded upstream. */
    expectedOutput?: string;
    /** True when the request is read-only from the configuration's view. */
    readOnly?: boolean;
    /** Number of files the repository profile saw, when known. */
    fileCount?: number;
}
export declare function describeFailureCost(inputs: FailureCostInputs): string;
/** Render the complexity scale for a prompt so the chooser knows the levels. */
export declare function complexityScaleText(): string;
export declare function isComplexityLevel(value: unknown): value is ComplexityLevel;
