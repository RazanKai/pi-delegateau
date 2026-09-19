import type { JevChoiceAnswer, JevChoiceInput } from "./types.js";
import type { ChoiceRuntime } from "./selection.js";
export interface JevClientLike {
    systemOne(request: unknown, options?: {
        signal?: AbortSignal;
        timeout?: number;
        retry?: {
            maxRetries: number;
        };
    }): Promise<any>;
}
export declare class JevSelector implements ChoiceRuntime {
    private readonly client;
    private readonly timeoutMs;
    /**
     * Client construction is defensive (F01 class): a missing API key or
     * transport failure becomes a normal choose() error inside the selection
     * deadline/fallback logic instead of a constructor throw outside it.
     */
    constructor(options?: {
        client?: JevClientLike;
        timeoutMs?: number;
    });
    choose(input: JevChoiceInput): Promise<JevChoiceAnswer>;
}
