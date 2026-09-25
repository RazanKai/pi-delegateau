import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  abandonTrial,
  beginTrial,
  emptyHealthState,
  getCircuitState,
  isHealthCategory,
  recordHealthFailure,
  recordHealthSuccess,
  resolveHealthConfig,
  type CircuitState,
  type HealthCategory,
  type HealthConfig,
  type HealthGate,
  type HealthRecord,
  type HealthState,
} from "./health.js";

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

export function healthPath(agentDir = getAgentDir()): string {
  return path.join(agentDir, "delegateau", "health.json");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize one persisted record defensively. A malformed field is dropped
 * rather than trusted, so a hand-edited or partially written file cannot crash
 * the dispatch path (the failure mode pi-bifrost documents for its own store).
 */
function normalizeRecord(raw: unknown): HealthRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const failures = Array.isArray(record.failures)
    ? record.failures.filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts))
    : [];
  const openUntil = finiteNumber(record.openUntil);
  const trialClaimedAt = finiteNumber(record.trialClaimedAt);
  const cooldownMultiplier = finiteNumber(record.cooldownMultiplier);
  const lastFailureAt = finiteNumber(record.lastFailureAt);
  const lastSuccessAt = finiteNumber(record.lastSuccessAt);
  return {
    failures,
    ...(openUntil !== undefined ? { openUntil } : {}),
    ...(record.trialActive === true ? { trialActive: true } : {}),
    ...(trialClaimedAt !== undefined ? { trialClaimedAt } : {}),
    ...(cooldownMultiplier !== undefined && cooldownMultiplier > 0 ? { cooldownMultiplier } : {}),
    ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
    ...(isHealthCategory(record.lastFailureCategory) ? { lastFailureCategory: record.lastFailureCategory } : {}),
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
  };
}

export function loadHealthState(filePath: string): HealthState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || raw.version !== 1 || typeof raw.models !== "object" || raw.models === null || Array.isArray(raw.models)) {
      return emptyHealthState();
    }
    const models: Record<string, HealthRecord> = {};
    for (const [key, value] of Object.entries(raw.models as Record<string, unknown>)) {
      const normalized = normalizeRecord(value);
      if (normalized) models[key] = normalized;
    }
    return { version: 1, models };
  } catch {
    // Missing, unreadable or corrupt: fail open with empty state.
    return emptyHealthState();
  }
}

export function saveHealthState(filePath: string, state: HealthState): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

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

export class HealthStore implements HealthGate {
  private state: HealthState;
  private pathValue: string;
  private config: HealthConfig | undefined;
  private readonly io: HealthIo;
  private readonly nowFn: () => number;
  private readonly cwd: string | undefined;

  constructor(options: HealthStoreOptions = {}) {
    this.io = options.io ?? { load: loadHealthState, save: saveHealthState };
    this.nowFn = options.now ?? Date.now;
    this.config = options.config;
    this.cwd = options.cwd;
    this.pathValue = this.resolvePath(options.path ?? options.config?.path);
    this.state = options.initialState ?? this.io.load(this.pathValue);
  }

  get path(): string {
    return this.pathValue;
  }

  /** Read-only view. Do not mutate. */
  getState(): Readonly<HealthState> {
    return this.state;
  }

  circuit(key: string, now?: number): CircuitState {
    // Disabled means fully transparent: no filtering, no trial claims, no
    // persisted mutations. Without this, a stale persisted circuit would still
    // exclude candidates even though the user turned the feature off.
    if (!resolveHealthConfig(this.config).enabled) {
      return { open: false, halfOpen: false, trialActive: false, recentFailures: 0 };
    }
    return getCircuitState(this.state, key, now ?? this.nowFn(), this.config);
  }

  isHealthy(key: string, now?: number): boolean {
    const circuit = this.circuit(key, now);
    return !circuit.open && !circuit.trialActive;
  }

  openCircuitCount(now?: number): number {
    if (!resolveHealthConfig(this.config).enabled) return 0;
    const at = now ?? this.nowFn();
    return Object.keys(this.state.models).filter((key) => getCircuitState(this.state, key, at, this.config).open).length;
  }

  /** Trials whose persisted claim is dead and can therefore be re-claimed. */
  expiredTrialCount(now?: number): number {
    if (!resolveHealthConfig(this.config).enabled) return 0;
    const at = now ?? this.nowFn();
    let count = 0;
    for (const [key, record] of Object.entries(this.state.models)) {
      if (record.trialActive !== true) continue;
      if (getCircuitState(this.state, key, at, this.config).trialActive) continue;
      count += 1;
    }
    return count;
  }

  /**
   * Sanitized health facts for `/delegateau status`: open circuits AND half-open
   * circuits whose trial claim is dead (no stamp, or older than the trial age).
   *
   * The dead-claim case is reported because it is otherwise invisible — the
   * circuit is not open, so an open-circuit count misses a model that every
   * dispatch will refuse with `trial-in-progress`. Reporting it also clears the
   * dead claim from disk, which is the only way such a state heals on its own.
   */
  openCircuits(now?: number): OpenCircuitSummary[] {
    if (!resolveHealthConfig(this.config).enabled) return [];
    const at = now ?? this.nowFn();
    const summaries: OpenCircuitSummary[] = [];
    let cleared = 0;
    let changed = false;
    let state = this.state;
    for (const [model, record] of Object.entries(state.models)) {
      const circuit = getCircuitState(state, model, at, this.config);
      const deadClaim = record.trialActive === true && !circuit.trialActive && circuit.halfOpen;
      if (deadClaim) {
        const next = abandonTrial(state, model);
        if (next !== state) {
          state = next;
          changed = true;
          cleared += 1;
        }
      }
      if (!circuit.open && !deadClaim) continue;
      summaries.push({
        model,
        ...(record.lastFailureCategory ? { category: record.lastFailureCategory } : {}),
        ...(circuit.openUntil !== undefined ? { openUntil: new Date(circuit.openUntil).toISOString() } : {}),
        trialActive: circuit.trialActive,
        ...(deadClaim ? { trialExpired: true, claimsCleared: 1 } : {}),
        ...(circuit.trialClaimedAt !== undefined ? { trialClaimedAt: new Date(circuit.trialClaimedAt).toISOString() } : {}),
      });
    }
    if (changed) {
      this.state = state;
      this.persist();
    }
    return summaries;
  }

  recordFailure(key: string, category: HealthCategory, now?: number): void {
    if (!resolveHealthConfig(this.config).enabled) return;
    const next = recordHealthFailure(this.state, key, this.config, now ?? this.nowFn(), category);
    if (next !== this.state) {
      this.state = next;
      this.persist();
    }
  }

  recordSuccess(key: string, now?: number): void {
    if (!resolveHealthConfig(this.config).enabled) return;
    const next = recordHealthSuccess(this.state, key, now ?? this.nowFn());
    if (next !== this.state) {
      this.state = next;
      this.persist();
    }
  }

  /**
   * Claim the one half-open trial. `allowed=false` means another dispatch owns a
   * live trial (or the circuit is still open), so this call must not launch.
   * A claim whose stamp is missing or expired is not owned by anyone and is
   * re-claimed here rather than blocking the model forever.
   */
  tryClaimTrial(key: string, now?: number): { allowed: boolean; claimed: boolean } {
    if (!resolveHealthConfig(this.config).enabled) return { allowed: true, claimed: false };
    const at = now ?? this.nowFn();
    const circuit = this.circuit(key, at);
    if (circuit.open || circuit.trialActive) return { allowed: false, claimed: false };
    if (!circuit.halfOpen) return { allowed: true, claimed: false };
    const next = beginTrial(this.state, key, at);
    if (next !== this.state) {
      this.state = next;
      this.persist();
    }
    return { allowed: true, claimed: true };
  }

  abandonTrial(key: string): void {
    if (!resolveHealthConfig(this.config).enabled) return;
    const next = abandonTrial(this.state, key);
    if (next !== this.state) {
      this.state = next;
      this.persist();
    }
  }

  reload(config?: HealthConfig, cwd?: string): void {
    if (config !== undefined) this.config = config;
    this.pathValue = this.resolvePath(this.config?.path, cwd ?? this.cwd);
    this.state = this.io.load(this.pathValue);
  }

  private persist(): void {
    this.io.save(this.pathValue, this.state);
  }

  private resolvePath(configured?: string, cwd = this.cwd): string {
    if (!configured) return healthPath();
    if (path.isAbsolute(configured)) return configured;
    if (configured.startsWith("~")) return path.join(os.homedir(), configured.slice(1));
    return path.join(cwd ?? process.cwd(), configured);
  }
}
