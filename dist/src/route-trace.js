export const MAX_TRACE_LIST = 200;
/**
 * Upper bound on benchmark records stored in one trace. The chooser has no such
 * cap (it receives every eligible candidate's records), so a trace that clipped
 * silently would let a reader reconstruct a decision from an incomplete list and
 * never know. `truncated`/`offeredCount` make the difference explicit.
 */
export const MAX_TRACE_BENCHMARKS = 512;
function cap(items) {
    return items.length > MAX_TRACE_LIST ? items.slice(0, MAX_TRACE_LIST) : items;
}
/** Collapse repeated exclusions for the same candidate, preserving order. */
export function mergeExcludedCandidates(...lists) {
    const merged = new Map();
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
function filterIds(excluded, reason) {
    return excluded.filter((item) => item.reasons.includes(reason)).map((item) => item.id);
}
function capProbabilities(probabilities) {
    if (!probabilities)
        return undefined;
    const entries = Object.entries(probabilities).slice(0, MAX_TRACE_LIST);
    return Object.fromEntries(entries);
}
function safeBenchmarkRecords(records) {
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
export function buildRouteTrace(input) {
    const excluded = mergeExcludedCandidates(input.excluded);
    const filters = {
        quotaExcluded: cap(filterIds(excluded, "quota-exhausted")),
        unreachable: cap(filterIds(excluded, "unreachable")),
        circuitOpen: cap(filterIds(excluded, "circuit-open")),
        trialActive: cap(filterIds(excluded, "trial-active")),
    };
    const probabilities = capProbabilities(input.jev?.probabilities);
    const jev = input.jev
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
