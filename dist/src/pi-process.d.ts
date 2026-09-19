import type { ChildEvent, ChildRequest } from "./types.js";
import type { ProbedTool } from "./child-extensions.js";
import type { ChildSpawner, SpawnResult } from "./runner.js";
export interface PiProcessOptions {
    command?: string;
    killGraceMs?: number;
}
export interface ExtensionToolProbeOptions {
    command?: string;
    cwd: string;
    extensionPaths: string[];
    requestedTools: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
}
/** True when the platform supports detached process groups we can signal. */
declare function supportsProcessGroups(): boolean;
/** Signal a whole process group, if we own a detached one. */
declare function signalGroup(pid: number | undefined, signal: NodeJS.Signals): boolean;
/**
 * Probe whether the owned process group still has live members other than the
 * direct child (which may already be reaped). On Linux this reads /proc for
 * processes whose PGID equals our child's PID.
 */
declare function groupHasSurvivors(pid: number | undefined, detached: boolean): boolean;
export declare class PiProcessSpawner implements ChildSpawner {
    private readonly command;
    private readonly killGraceMs;
    constructor(options?: PiProcessOptions);
    spawn(request: ChildRequest, emit: (event: ChildEvent) => void): Promise<SpawnResult>;
    private runProcess;
}
export declare function probePiExtensionTools(options: ExtensionToolProbeOptions): Promise<ProbedTool[]>;
export { groupHasSurvivors, signalGroup, supportsProcessGroups };
