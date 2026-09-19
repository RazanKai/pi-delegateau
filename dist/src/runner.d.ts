import type { ChildEvent, ChildRequest, ChildResult, ModelIdentity } from "./types.js";
export interface SpawnResult {
    exitCode: number;
    observedExit: boolean;
}
export interface ChildSpawner {
    spawn(request: ChildRequest, emit: (event: ChildEvent) => void): Promise<SpawnResult>;
}
declare function modelFromEvidence(value: string | undefined): ModelIdentity | undefined;
export declare class ChildRunner {
    private readonly spawner;
    constructor(spawner: ChildSpawner);
    run(request: ChildRequest, onProgress?: (text: string) => void): Promise<ChildResult>;
}
export { modelFromEvidence };
