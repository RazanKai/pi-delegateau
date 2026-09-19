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
    constructor(options?: {
        client?: JevClientLike;
        timeoutMs?: number;
    });
    choose(input: JevChoiceInput): Promise<JevChoiceAnswer>;
}
