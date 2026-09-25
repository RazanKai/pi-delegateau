import { type CircuitState, type HealthCategory, type HealthConfig, type HealthGate, type HealthState } from "./health.js";
/**
 * Persistence facade for runtime health. This is the only place that touches
 * disk; `health.ts` stays a pure state machine.
 *
 * State lives under the Pi agent directory (`<agentDir>/delegateau/health.json`)
 * so it survives restarts and is shared by every project on this machine, which
 * is correct: a provider quota or a refused model is an account-level fact.
 * Writes are atomic (temp file + rename) and human-readable (indented JSON).
 * Any missing, malformed or unreadable state fails OPEN: health never blocks
 * delegation on its own corruption.
 */
export interface HealthIo {
    load(path: string): HealthState;
    save(path: string, state: HealthState): void;
}
export declare function healthPath(agentDir?: string): string;
export declare function loadHealthState(filePath: string): HealthState;
export declare function saveHealthState(filePath: string, state: HealthState): void;
export interface HealthStoreOptions {
    cwd?: string | undefined;
    config?: HealthConfig | undefined;
    /** Explicit path wins over `config.path`; injectable for tests. */
    path?: string | undefined;
    io?: HealthIo;
    now?: () => number;
    initialState?: HealthState;
}
export interface OpenCircuitSummary {
    model: string;
    category?: HealthCategory;
    openUntil?: string;
    trialActive: boolean;
    /** A persisted claim with no valid stamp, or one older than the trial age. */
    trialExpired?: boolean;
    trialClaimedAt?: string;
    /** Trials with a dead claim that this call observed and cleared from disk. */
    claimsCleared?: number;
}
export declare class HealthStore implements HealthGate {
    private state;
    private pathValue;
    private config;
    private readonly io;
    private readonly nowFn;
    private readonly cwd;
    constructor(options?: HealthStoreOptions);
    get path(): string;
    /** Read-only view. Do not mutate. */
    getState(): Readonly<HealthState>;
    circuit(key: string, now?: number): CircuitState;
    isHealthy(key: string, now?: number): boolean;
    openCircuitCount(now?: number): number;
    /** Trials whose persisted claim is dead and can therefore be re-claimed. */
    expiredTrialCount(now?: number): number;
    /**
     * Sanitized health facts for `/delegateau status`: open circuits AND half-open
     * circuits whose trial claim is dead (no stamp, or older than the trial age).
     *
     * The dead-claim case is reported because it is otherwise invisible — the
     * circuit is not open, so an open-circuit count misses a model that every
     * dispatch will refuse with `trial-in-progress`. Reporting it also clears the
     * dead claim from disk, which is the only way such a state heals on its own.
     */
    openCircuits(now?: number): OpenCircuitSummary[];
    recordFailure(key: string, category: HealthCategory, now?: number): void;
    recordSuccess(key: string, now?: number): void;
    /**
     * Claim the one half-open trial. `allowed=false` means another dispatch owns a
     * live trial (or the circuit is still open), so this call must not launch.
     * A claim whose stamp is missing or expired is not owned by anyone and is
     * re-claimed here rather than blocking the model forever.
     */
    tryClaimTrial(key: string, now?: number): {
        allowed: boolean;
        claimed: boolean;
    };
    abandonTrial(key: string): void;
    reload(config?: HealthConfig, cwd?: string): void;
    private persist;
    private resolvePath;
}
