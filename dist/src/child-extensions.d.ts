export interface ResolvedChildExtensions {
    paths: string[];
    packageNames: string[];
}
export interface ProbedTool {
    name: string;
    source?: {
        path?: string;
        source?: string;
        baseDir?: string;
    };
}
export declare function resolveChildExtensions(selectors: string[], cwd: string, agentDir?: string): Promise<ResolvedChildExtensions>;
export declare function validateProbedChildTools(requestedTools: string[], extensionPaths: string[], probed: ProbedTool[]): string[];
