import type { ChildEvent, ChildRequest } from "./types.js";
import type { ChildSpawner, SpawnResult } from "./runner.js";
export interface PiProcessOptions {
    command?: string;
    killGraceMs?: number;
}
export declare class PiProcessSpawner implements ChildSpawner {
    private readonly command;
    private readonly killGraceMs;
    constructor(options?: PiProcessOptions);
    spawn(request: ChildRequest, emit: (event: ChildEvent) => void): Promise<SpawnResult>;
    private runProcess;
}
