import * as fs from "node:fs";
import * as path from "node:path";
import {
  COMPLEXITY_EFFORT,
  COMPLEXITY_LEVELS,
  type CandidateProfile,
  type ComplexityLevel,
  type ModelIdentity,
  type RepositoryProfile,
} from "./types.js";

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
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
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
  cost?: { input?: number; output?: number; cacheRead?: number };
  costSource: "provider" | "user";
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  inputModalities?: string[];
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Build the cost triple from a provider registry entry. Returns undefined when
 * the provider declared nothing usable — an unknown price must stay unknown
 * rather than being filled with a guess.
 */
function providerCost(model: RegistryModelLike): ResolvedCandidateData["cost"] | undefined {
  const input = positive(model.cost?.input);
  const output = positive(model.cost?.output);
  const cacheRead = positive(model.cost?.cacheRead);
  if (input === undefined && output === undefined && cacheRead === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
  };
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
export function resolveCandidateData(
  identity: ModelIdentity,
  configured: Pick<CandidateProfile, "cost" | "contextWindow">,
  registry: ModelRegistryLike | undefined,
): ResolvedCandidateData {
  const model = registry?.find(identity.provider, identity.id);
  const liveCost = model ? providerCost(model) : undefined;
  const liveContext = model ? positive(model.contextWindow) : undefined;
  const liveMaxOut = model ? positive(model.maxTokens) : undefined;
  const modalities = model?.input?.filter((value): value is string => typeof value === "string");

  if (liveCost) {
    return {
      cost: liveCost,
      costSource: "provider",
      ...(liveContext !== undefined ? { contextWindow: liveContext } : {}),
      ...(liveMaxOut !== undefined ? { maxOutputTokens: liveMaxOut } : {}),
      ...(typeof model?.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(modalities && modalities.length > 0 ? { inputModalities: modalities } : {}),
    };
  }

  // No provider price: fall back to the authored figure, explicitly labelled as
  // unverified, and still prefer a provider-declared context window.
  const userCost =
    configured.cost && (configured.cost.input !== undefined || configured.cost.output !== undefined)
      ? {
          ...(positive(configured.cost.input) !== undefined ? { input: configured.cost.input as number } : {}),
          ...(positive(configured.cost.output) !== undefined ? { output: configured.cost.output as number } : {}),
        }
      : undefined;
  const contextWindow = liveContext ?? positive(configured.contextWindow);
  return {
    ...(userCost ? { cost: userCost } : {}),
    costSource: userCost ? "user" : "provider",
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(liveMaxOut !== undefined ? { maxOutputTokens: liveMaxOut } : {}),
    ...(typeof model?.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    ...(modalities && modalities.length > 0 ? { inputModalities: modalities } : {}),
  };
}

/**
 * Estimate the input cost of a dispatch at a given context size. This is what
 * exposes the real burn: measured dispatches spent 95% of their tokens on
 * INPUT, so the driver is (context size) x (input price), and input prices in
 * the pool span ~200x. Returns undefined when price or size is unknown.
 */
export function estimateInputCost(data: ResolvedCandidateData, inputTokens: number | undefined): number | undefined {
  const price = data.cost?.input;
  if (price === undefined || inputTokens === undefined) return undefined;
  return (inputTokens / 1_000_000) * price;
}

// ---------------------------------------------------------------------------
// Repository profile
// ---------------------------------------------------------------------------

const PROFILE_DIR_LIMIT = 40;
const PROFILE_FILE_COUNT_LIMIT = 5_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "target", ".next", "coverage"]);

/**
 * Build a bounded, non-source repository profile.
 *
 * Contains directory NAMES, a file count, safe manifest metadata (name, script
 * names, dependency count) and the names of loaded context files. It never
 * reads source bodies or conversation history, and it is truncated by
 * construction rather than by a downstream cap.
 */
export function buildRepositoryProfile(cwd: string, contextFileNames: string[] = []): RepositoryProfile {
  const directories: string[] = [];
  let fileCount = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > 2 || fileCount >= PROFILE_FILE_COUNT_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (directories.length < PROFILE_DIR_LIMIT) {
          const rel = path.relative(cwd, path.join(dir, entry.name));
          directories.push(rel);
        }
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        fileCount += 1;
        if (fileCount >= PROFILE_FILE_COUNT_LIMIT) return;
      }
    }
  };
  walk(cwd, 1);

  const profile: RepositoryProfile = { directories, contextFileNames };
  if (fileCount > 0) profile.fileCount = fileCount;

  // Safe manifest metadata: names and counts only, never dependency contents.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const scripts = raw.scripts && typeof raw.scripts === "object" ? Object.keys(raw.scripts) : [];
      const deps = raw.dependencies && typeof raw.dependencies === "object" ? Object.keys(raw.dependencies).length : 0;
      const devDeps = raw.devDependencies && typeof raw.devDependencies === "object" ? Object.keys(raw.devDependencies).length : 0;
      profile.manifest = {
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        scriptNames: scripts.slice(0, 20),
        dependencyCount: deps + devDeps,
      };
    }
  } catch {
    // No readable manifest is normal and not an error.
  }

  if (!fs.existsSync(path.join(cwd, ".git"))) profile.nonGit = true;
  return profile;
}

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

export function describeFailureCost(inputs: FailureCostInputs): string {
  const factors: string[] = [];
  if (inputs.readOnly) factors.push("the work is read-only, so a wrong answer costs only the attempt");
  else factors.push("the work mutates the repository, so a wrong answer must be detected and undone");
  if (inputs.expectedOutput) factors.push("the parent stated explicit acceptance criteria, making a failed attempt detectable before integration");
  else factors.push("no explicit acceptance criteria were supplied, so a wrong answer may go unnoticed");
  if (inputs.fileCount !== undefined && inputs.fileCount > 400) factors.push(`the workspace is large (${inputs.fileCount}+ files), widening the blast radius of an incorrect edit`);
  return factors.join("; ");
}

/** Render the complexity scale for a prompt so the chooser knows the levels. */
export function complexityScaleText(): string {
  return COMPLEXITY_LEVELS.map((level) => `${level} (effort ${COMPLEXITY_EFFORT[level]})`).join(", ");
}

export function isComplexityLevel(value: unknown): value is ComplexityLevel {
  return typeof value === "string" && (COMPLEXITY_LEVELS as readonly string[]).includes(value);
}
