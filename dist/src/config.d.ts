import type { DelegateConfig, DelegateLimits } from "./types.js";
declare const DEFAULT_LIMITS: DelegateLimits;
export declare function parseConfig(raw: unknown): DelegateConfig;
export { DEFAULT_LIMITS };
export declare const CONFIG_FILE_NAME = ".pi/delegateau.json";
export declare function loadConfig(cwd: string): DelegateConfig;
