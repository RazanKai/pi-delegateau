import type { DelegateConfig, DelegateLimits } from "./types.js";
declare const DEFAULT_LIMITS: DelegateLimits;
declare const MUTATION_TOOLS: Set<string>;
declare const KNOWN_COORDINATION_TOOLS: Set<string>;
declare const CHILD_TOOLS: Set<string>;
export declare function parseConfig(raw: unknown, now?: number): DelegateConfig;
export { DEFAULT_LIMITS, KNOWN_COORDINATION_TOOLS, MUTATION_TOOLS, CHILD_TOOLS };
export declare const CONFIG_FILE_NAME = ".pi/delegateau.json";
/** The agent directory Pi owns: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export declare function agentDirPath(env?: NodeJS.ProcessEnv): string;
/** The user-level config, applied in every project that has no project config. */
export declare function globalConfigPath(env?: NodeJS.ProcessEnv): string;
export type ConfigSource = "project" | "global" | "defaults";
export interface ResolvedConfig {
    config: DelegateConfig;
    source: ConfigSource;
    path?: string;
}
/**
 * Resolve delegateau's config: the project file wins when it exists, otherwise
 * the global agent-dir file applies, otherwise built-in defaults.
 *
 * A project file REPLACES the global one rather than merging with it, so a
 * project cannot end up with a half-global policy that no single file states.
 */
export declare function resolveConfig(input: {
    cwd: string;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
}): ResolvedConfig;
/** Back-compat wrapper: the project config when present, else the global one. */
export declare function loadConfig(cwd: string): DelegateConfig;
