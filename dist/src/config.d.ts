import type { DelegateConfig, DelegateLimits } from "./types.js";
declare const DEFAULT_LIMITS: DelegateLimits;
declare const MUTATION_TOOLS: Set<string>;
declare const KNOWN_COORDINATION_TOOLS: Set<string>;
declare const CHILD_TOOLS: Set<string>;
export declare function parseConfig(raw: unknown): DelegateConfig;
export { DEFAULT_LIMITS, KNOWN_COORDINATION_TOOLS, MUTATION_TOOLS, CHILD_TOOLS };
export declare const CONFIG_FILE_NAME = ".pi/delegateau.json";
export declare function loadConfig(cwd: string): DelegateConfig;
