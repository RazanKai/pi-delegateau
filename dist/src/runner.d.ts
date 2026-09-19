import type { ChildEvent, ChildRequest, ChildResult, ModelIdentity } from "./types.js";
export interface SpawnResult {
    exitCode: number;
    observedExit: boolean;
    processStarted?: boolean;
    groupCleaned?: boolean;
}
export interface ChildSpawner {
    spawn(request: ChildRequest, emit: (event: ChildEvent) => void): Promise<SpawnResult>;
}
declare function identityFromEvidence(value: string | undefined): ModelIdentity | undefined;
/** Merge a per-turn usage event into running totals without dropping earlier fields. */
declare function mergeUsage(total: ChildResult["usage"] | undefined, event: ChildResult["usage"] | undefined): ChildResult["usage"] | undefined;
export declare class ChildRunner {
    private readonly spawner;
    constructor(spawner: ChildSpawner);
    run(request: ChildRequest, onProgress?: (text: string) => void): Promise<ChildResult>;
}
export { identityFromEvidence as modelFromEvidence, mergeUsage };
