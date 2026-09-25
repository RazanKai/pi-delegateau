import type { HealthCategory } from "./health.js";
import type { BenchmarkEvidence, SelectionSource } from "./types.js";

/**
 * Structured route trace.
 *
 * PURPOSE: make every delegation/selection decision explainable after the fact
 * without persisting private data. The trace is linked to the existing receipt
 * by `dispatchId`/`decisionId` and is written through the same `receipts.ts`
 * path — it is an extension of the receipt record, not a second logging system.
 *
 * SAFETY: the builder only accepts structured identities, stable reasons and
 * numbers. It has no parameter for task text, prompt text, context, child
 * output, repository contents, secrets or raw provider bodies, so those cannot
 * leak into the trace even by mistake. Lists are capped so the record is bounded.
 */

export type RouteExclusionReason =
  | "not-in-registry"
  | "no-auth"
  | "unreachable"
  | "quota-exhausted"
  | "circuit-open"
  | "trial-active"
  | "child-tools-invalid";

export interface RouteExcludedCandidate {
  id: string;
  reasons: RouteExclusionReason[];
  openUntil?: string;
}

export interface RouteTraceFilters {
  /** Candidate ids excluded because a provider quota window was at the floor. */
  quotaExcluded: string[];
  /** Candidate ids excluded by a fresh negative reachability probe. */
  unreachable: string[];
  /** Candidate ids excluded because their health circuit is open. */
  circuitOpen: string[];
  /** Candidate ids excluded because a half-open trial is already in flight. */
  trialActive: string[];
}

export interface RouteTraceJev {
  latencyMs?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface RouteTraceBenchmarks {
  /** True only when these records were included in the model Choice request. */
  offeredToJev: boolean;
  records: BenchmarkEvidence[];
  /** Records the chooser actually received, before the trace's own cap. */
  offeredCount: number;
  /** True when the trace cap dropped records; `records` is then a prefix. */
  truncated: boolean;
}

export interface RouteTrace {
  version: 1;
  dispatchId: string;
  decisionId?: string;
  agent: string;
  startedAt: string;
  endedAt: string;
  candidateIds: string[];
  excluded: RouteExcludedCandidate[];
  selectionSource: SelectionSource | "unselected";
  requestedModel?: string;
  selectedModel?: string;
  appliedModel?: string;
  servedModel?: string;
  jev?: RouteTraceJev;
  benchmarks?: RouteTraceBenchmarks;
  filters: RouteTraceFilters;
  outcome: string;
  errorCategory?: HealthCategory;
}

export interface RouteTraceInput {
  dispatchId: string;
  decisionId?: string;
  agent: string;
  startedAt: string;
  endedAt: string;
  candidateIds: string[];
  excluded: RouteExcludedCandidate[];
  selectionSource: SelectionSource | "unselected";
  requestedModel?: string;
  selectedModel?: string;
  appliedModel?: string;
  servedModel?: string;
  jev?: RouteTraceJev;
  benchmarkEvidence?: BenchmarkEvidence[];
  benchmarksOfferedToJev?: boolean;
  outcome: string;
  errorCategory?: HealthCategory;
}

export const MAX_TRACE_LIST = 200;
/**
 * Upper bound on benchmark records stored in one trace. The chooser has no such
 * cap (it receives every eligible candidate's records), so a trace that clipped
 * silently would let a reader reconstruct a decision from an incomplete list and
 * never know. `truncated`/`offeredCount` make the difference explicit.
 */
export const MAX_TRACE_BENCHMARKS = 512;

function cap<T>(items: T[]): T[] {
  return items.length > MAX_TRACE_LIST ? items.slice(0, MAX_TRACE_LIST) : items;
}

/** Collapse repeated exclusions for the same candidate, preserving order. */
export function mergeExcludedCandidates(...lists: RouteExcludedCandidate[][]): RouteExcludedCandidate[] {
  const merged = new Map<string, RouteExcludedCandidate>();
  for (const list of lists) {
    for (const item of list) {
      const existing = merged.get(item.id);
      if (!existing) {
        merged.set(item.id, { id: item.id, reasons: [...item.reasons], ...(item.openUntil ? { openUntil: item.openUntil } : {}) });
        continue;
      }
      const reasons = [...new Set([...existing.reasons, ...item.reasons])];
      merged.set(item.id, {
        id: item.id,
        reasons,
        ...(existing.openUntil ?? item.openUntil ? { openUntil: existing.openUntil ?? item.openUntil } : {}),
      });
    }
  }
  return [...merged.values()];
}

function filterIds(excluded: RouteExcludedCandidate[], reason: RouteExclusionReason): string[] {
  return excluded.filter((item) => item.reasons.includes(reason)).map((item) => item.id);
}

function capProbabilities(probabilities: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!probabilities) return undefined;
  const entries = Object.entries(probabilities).slice(0, MAX_TRACE_LIST);
  return Object.fromEntries(entries);
}

function safeBenchmarkRecords(records: BenchmarkEvidence[] | undefined): BenchmarkEvidence[] {
  return (records ?? []).slice(0, MAX_TRACE_BENCHMARKS).map((record) => ({
    model: { provider: record.model.provider, id: record.model.id },
    source: record.source,
    sourceUrl: record.sourceUrl,
    benchmark: record.benchmark,
    version: record.version,
    metric: record.metric,
    date: record.date,
    dateKind: record.dateKind,
    provenance: record.provenance,
    score: record.score,
    unit: record.unit,
    direction: record.direction,
  }));
}

export function buildRouteTrace(input: RouteTraceInput): RouteTrace {
  const excluded = mergeExcludedCandidates(input.excluded);
  const filters: RouteTraceFilters = {
    quotaExcluded: cap(filterIds(excluded, "quota-exhausted")),
    unreachable: cap(filterIds(excluded, "unreachable")),
    circuitOpen: cap(filterIds(excluded, "circuit-open")),
    trialActive: cap(filterIds(excluded, "trial-active")),
  };
  const probabilities = capProbabilities(input.jev?.probabilities);
  const jev: RouteTraceJev | undefined = input.jev
    ? {
        ...(input.jev.latencyMs !== undefined ? { latencyMs: input.jev.latencyMs } : {}),
        ...(input.jev.confidence !== undefined ? { confidence: input.jev.confidence } : {}),
        ...(probabilities ? { probabilities } : {}),
      }
    : undefined;

  return {
    version: 1,
    dispatchId: input.dispatchId,
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    agent: input.agent,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    candidateIds: cap([...input.candidateIds]),
    excluded: cap(excluded),
    selectionSource: input.selectionSource,
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
    ...(input.selectedModel ? { selectedModel: input.selectedModel } : {}),
    ...(input.appliedModel ? { appliedModel: input.appliedModel } : {}),
    ...(input.servedModel ? { servedModel: input.servedModel } : {}),
    ...(jev && Object.keys(jev).length > 0 ? { jev } : {}),
    ...(input.benchmarkEvidence?.length || input.benchmarksOfferedToJev !== undefined
      ? {
          benchmarks: {
            offeredToJev: input.benchmarksOfferedToJev === true,
            records: safeBenchmarkRecords(input.benchmarkEvidence),
            offeredCount: input.benchmarkEvidence?.length ?? 0,
            truncated: (input.benchmarkEvidence?.length ?? 0) > MAX_TRACE_BENCHMARKS,
          },
        }
      : {}),
    filters,
    outcome: input.outcome,
    ...(input.errorCategory ? { errorCategory: input.errorCategory } : {}),
  };
}
