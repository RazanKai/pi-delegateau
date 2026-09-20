/** The shape both selectors call. Structural, so a test stub satisfies it. */
export interface JevClientLike {
    systemOne(request: unknown, options?: {
        signal?: AbortSignal;
        timeout?: number;
        retry?: {
            maxRetries: number;
        };
    }): Promise<any>;
}
/** Test-only hook: forget cached clients so a stub can be installed. */
export declare function resetJevClientCache(): void;
/**
 * The shared client for a timeout, or `undefined` when credentials or the
 * transport are unusable. Never throws: construction failure is a normal
 * choose() error inside the caller's deadline/fallback logic, not a constructor
 * throw outside it (F01).
 */
export declare function sharedJevClient(timeoutMs: number): JevClientLike | undefined;
