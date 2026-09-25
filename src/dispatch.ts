import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdmissionError, type DispatchAdmission } from "./admission.js";
import { collectBenchmarkEvidence } from "./benchmarks.js";
import { resolveChildExtensions, validateProbedChildTools } from "./child-extensions.js";
import { CHILD_TOOLS } from "./config.js";
import { resolveEligibleCandidates } from "./eligibility.js";
import { classifyChildHealth, type HealthCategory } from "./health.js";
import { HealthStore } from "./health-store.js";
import { JevSelector } from "./jev.js";
import { quotaSelectorOptions } from "./selector-options.js";
import { readQuotaState } from "./quota.js";
import { PiProcessSpawner, probePiExtensionTools } from "./pi-process.js";
import { appendReceipt, defaultReceiptPath } from "./receipt-store.js";
import { buildReceipt, dispatchSummary, sanitizeError } from "./receipts.js";
import { buildRouteTrace, mergeExcludedCandidates, type RouteExcludedCandidate, type RouteTrace } from "./route-trace.js";
import { ChildRunner } from "./runner.js";
import { selectModel } from "./selection.js";
import { modelKey, type BenchmarkEvidence, type CandidateProfile, type ChildResult, type ComplexityLevel, type DelegateConfig, type DelegateRequest, type JevChoiceInput, type ModelIdentity, type SelectionResult, type TrustedAgent } from "./types.js";

export interface AssignmentInput {
  agent: string;
  task: string;
  expectedOutput?: string;
  context?: string;
}

export class DispatchFailure extends Error {
  constructor(readonly payload: { text: string; details: Record<string, unknown> }) {
    super(payload.text);
    this.name = "DispatchFailure";
  }
}

export interface ExecuteDispatchOptions {
  config: DelegateConfig;
  agent: TrustedAgent;
  assignment: AssignmentInput;
  ctx: ExtensionContext;
  pool: DispatchAdmission;
  signal?: AbortSignal;
  onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void;
  decisionId?: string;
  /** Difficulty the gate judged for this request, forwarded to the chooser. */
  complexity?: ComplexityLevel;
  /** Shared health store; one per `delegate_task` call so batch siblings see each other's trials. */
  health?: HealthStore;
  registerController: (controller: AbortController) => void;
  unregisterController: (controller: AbortController) => void;
  markDelegated: () => void;
}

function profileVersion(config: DelegateConfig): string {
  return `v1:${config.candidates.map((candidate) => JSON.stringify(candidate)).sort().join("|")}`;
}

async function writeSafeReceipt(config: DelegateConfig, input: Parameters<typeof buildReceipt>[0], notify: (message: string) => void): Promise<void> {
  try {
    await appendReceipt(config.receiptPath ?? defaultReceiptPath(), buildReceipt(input));
  } catch (error) {
    notify(`Receipt warning: ${sanitizeError(error instanceof Error ? error.message : String(error))}`);
  }
}

function update(options: ExecuteDispatchOptions, dispatchId: string, status: string, text: string, details: Record<string, unknown> = {}): void {
  options.onUpdate?.({ content: [{ type: "text", text: `[${dispatchId}] ${text}` }], details: { dispatchId, status, at: new Date().toISOString(), ...details } });
}

export async function executeDispatch(options: ExecuteDispatchOptions): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const { config, agent, assignment, ctx, pool } = options;
  const dispatchId = randomUUID();
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  options.registerController(controller);
  // One store per dispatch unless the caller shares one (batch calls do). The
  // default resolves the persisted file under the Pi agent state area.
  const health = options.health ?? new HealthStore({ cwd: ctx.cwd, config: config.health });

  let selectedIdentity: ModelIdentity | undefined;
  let selectedSource: SelectionResult["source"] | undefined;
  let selection: SelectionResult | undefined;
  let childResult: ChildResult | undefined;
  let eligibleIds: string[] = [];
  let preExcluded: RouteExcludedCandidate[] = [];
  let revalidationExcluded: RouteExcludedCandidate[] = [];
  let benchmarkEvidence: BenchmarkEvidence[] = [];
  let benchmarksOfferedToJev = false;
  let receiptAttempted = false;
  let blockedReason: string | undefined;
  let lease: Awaited<ReturnType<DispatchAdmission["acquire"]>> | undefined;
  let trialClaimed = false;
  let healthCategory: HealthCategory | undefined;

  const traceFor = (outcome: string): RouteTrace => buildRouteTrace({
    dispatchId,
    ...(options.decisionId ? { decisionId: options.decisionId } : {}),
    agent: agent.name,
    startedAt,
    endedAt: new Date().toISOString(),
    candidateIds: eligibleIds,
    excluded: mergeExcludedCandidates(preExcluded, revalidationExcluded),
    selectionSource: selectedSource ?? "unselected",
    ...(selectedIdentity ? { requestedModel: modelKey(selectedIdentity) } : {}),
    ...(selectedIdentity ? { selectedModel: modelKey(selectedIdentity) } : {}),
    ...(childResult ? { appliedModel: modelKey(childResult.appliedModel) } : {}),
    ...(childResult?.servedModel ? { servedModel: modelKey(childResult.servedModel) } : {}),
    ...(selection ? {
      jev: {
        ...(selection.chooserLatencyMs !== undefined ? { latencyMs: selection.chooserLatencyMs } : {}),
        ...(selection.confidence !== undefined ? { confidence: selection.confidence } : {}),
        ...(selection.probabilities ? { probabilities: selection.probabilities } : {}),
      },
    } : {}),
    ...(benchmarkEvidence.length > 0 || benchmarksOfferedToJev ? { benchmarkEvidence, benchmarksOfferedToJev } : {}),
    outcome,
    ...(healthCategory ? { errorCategory: healthCategory } : {}),
  });

  /**
   * Attribute a finished child to model health. The APPLIED model owns the
   * outcome, so a provider substitution does not blame the requested identity;
   * a trial claimed on the requested model is released first. Nothing is
   * recorded before the child started, and cancellation/task-failure/cleanup
   * never count (see health.ts).
   */
  const recordChildHealth = (result: ChildResult): void => {
    const appliedKey = modelKey(result.appliedModel);
    const selectedKey = selectedIdentity ? modelKey(selectedIdentity) : appliedKey;
    const verdict = classifyChildHealth({
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      ...(result.processStarted !== undefined ? { processStarted: result.processStarted } : {}),
      observedExit: result.observedExit,
      ...(result.groupCleaned !== undefined ? { groupCleaned: result.groupCleaned } : {}),
    });
    if (verdict.kind !== "success") healthCategory = verdict.category;
    if (!result.processStarted) {
      if (trialClaimed) health.abandonTrial(selectedKey);
      trialClaimed = false;
      return;
    }
    if (trialClaimed && appliedKey !== selectedKey) {
      // Substitution: release the requested identity's untested trial and
      // attribute the serving outcome to the model that actually ran.
      health.abandonTrial(selectedKey);
      trialClaimed = false;
    }
    if (verdict.kind === "success") {
      health.recordSuccess(appliedKey);
    } else if (verdict.kind === "failure") {
      health.recordFailure(appliedKey, verdict.category);
    } else if (trialClaimed) {
      health.abandonTrial(selectedKey);
    }
    trialClaimed = false;
  };

  try {
    lease = await pool.acquire(dispatchId, {
      signal: controller.signal,
      onPosition: (position) => update(options, dispatchId, "queued", `queued at position ${position}`, { queuePosition: position }),
    });
    if (controller.signal.aborted) throw new AdmissionError("Delegation cancelled before launch", "cancelled");
    update(options, dispatchId, "selecting", "resolving child extensions and eligible models...");

    const resolvedExtensions = await resolveChildExtensions(agent.childExtensions ?? [], ctx.cwd);
    const probed = resolvedExtensions.paths.length > 0
      ? await probePiExtensionTools({
          ...(config.piCommand ? { command: config.piCommand } : {}),
          cwd: ctx.cwd,
          extensionPaths: resolvedExtensions.paths,
          requestedTools: agent.tools,
          signal: controller.signal,
          timeoutMs: Math.min(config.limits.childWallTimeMs, 30_000),
        })
      : [];
    const tools = validateProbedChildTools(agent.tools, resolvedExtensions.paths, probed);

    const quotaState = readQuotaState();
    const eligible = resolveEligibleCandidates({ config, agent, ctx, quotaState, health, enrich: true });
    const candidates = eligible.candidates;
    eligibleIds = candidates.map((candidate) => modelKey(candidate.identity));
    preExcluded = eligible.excluded;
    // Capture the exact records the chooser can see before selection so the
    // receipt proves what was (or was not) offered to it.
    benchmarkEvidence = collectBenchmarkEvidence(candidates);
    const request: DelegateRequest = {
      agent,
      task: assignment.task,
      ...(assignment.expectedOutput ? { expectedOutput: assignment.expectedOutput } : {}),
      ...(assignment.context ? { context: assignment.context } : {}),
      preference: config.preference,
      // The gate already judged this request's difficulty; hand it to the
      // chooser rather than making it re-infer difficulty from the task text.
      ...(options.complexity ? { complexity: options.complexity } : {}),
      candidates,
      ...(quotaState && Object.keys(quotaState).length > 0 ? { quotaState } : {}),
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
      selectionMode: config.selection,
      allowExternalSensing: config.allowExternalSensing,
      selectionDeadlineMs: config.limits.selectionDeadlineMs,
    };
    selection = await selectModel(request, {
      choose: (input: JevChoiceInput) => new JevSelector(quotaSelectorOptions(config.limits.selectionDeadlineMs, config.costMode, quotaState)).choose(input),
      signal: controller.signal,
    });
    selectedIdentity = selection.identity;
    selectedSource = selection.source;
    // `jev` and `fallback` both mean the model chooser actually ran; `fixed`,
    // `pin` and `single-candidate` never sent the records anywhere.
    benchmarksOfferedToJev = selection.source === "jev" || selection.source === "fallback";
    const revalidated = resolveEligibleCandidates({ config, agent, ctx, quotaState: readQuotaState(), health, enrich: false });
    revalidationExcluded = revalidated.excluded;
    if (!revalidated.candidates.some((candidate) => modelKey(candidate.identity) === modelKey(selection!.identity))) {
      throw new Error(`Selected model ${modelKey(selection.identity)} is no longer eligible`);
    }

    // Claim the one half-open recovery trial immediately before launch. A
    // concurrent dispatch that owns the trial means this one must not launch.
    const selectedKey = modelKey(selection.identity);
    const claim = health.tryClaimTrial(selectedKey);
    if (!claim.allowed) {
      throw new DispatchFailure({
        text: `Dispatch ${dispatchId}: launch-error\nSelected model ${selectedKey} is already in a half-open recovery trial`,
        details: { dispatchId, status: "launch-error", error: "trial-in-progress" },
      });
    }
    trialClaimed = claim.claimed;

    update(options, dispatchId, "running", `${selection.source}: ${modelKey(selection.identity)}; child starting...`, { selection });
    const runner = new ChildRunner(new PiProcessSpawner({ ...(config.piCommand ? { command: config.piCommand } : {}) }));
    const result = await runner.run({
      model: selection.identity,
      task: assignment.task,
      ...(assignment.expectedOutput ? { expectedOutput: assignment.expectedOutput } : {}),
      ...(assignment.context ? { context: assignment.context } : {}),
      instructions: agent.instructions,
      tools,
      extensionPaths: resolvedExtensions.paths,
      cwd: ctx.cwd,
      ...(config.childThinking ? { thinking: config.childThinking } : {}),
      signal: controller.signal,
      wallTimeMs: config.limits.childWallTimeMs,
      maxTurns: config.limits.childMaxTurns,
      maxOutputChars: config.limits.childOutputChars,
    }, (text) => update(options, dispatchId, "running", text));

    childResult = result;
    recordChildHealth(result);

    receiptAttempted = true;
    if (result.processStarted && (!result.observedExit || result.groupCleaned === false)) {
      blockedReason = "child exit or process-group cleanup not observed; manual recovery required";
    }
    if (result.processStarted) options.markDelegated();
    await writeSafeReceipt(config, {
      dispatchId,
      ...(options.decisionId ? { decisionId: options.decisionId } : {}),
      agent: agent.name,
      identity: result.appliedModel,
      ...(result.servedModel ? { servedModel: result.servedModel } : {}),
      requestedModel: selection.identity,
      source: selection.source,
      preference: config.preference,
      eligibleIds,
      profileVersion: profileVersion(config),
      outcome: result.status,
      ...(selection.probabilities ? { selectionProbabilities: selection.probabilities } : {}),
      ...(selection.confidence !== undefined ? { confidence: selection.confidence } : {}),
      ...(selection.chooserLatencyMs !== undefined ? { chooserLatencyMs: selection.chooserLatencyMs } : {}),
      ...(selection.cause ? { fallbackCause: selection.cause } : {}),
      usage: { chooser: selection.usage, child: result.usage },
      ...(result.error ? { errorCategory: result.status } : {}),
      ...(result.groupCleaned !== undefined ? { groupCleaned: result.groupCleaned } : {}),
      ...(result.outputTruncated ? { outputTruncated: true } : {}),
      routeTrace: traceFor(result.status),
    }, (message) => ctx.ui.notify(message, "warning"));

    const text = [
      `Dispatch ${dispatchId}: ${result.status}`,
      `Agent: ${agent.name}`,
      `Selection: ${dispatchSummary(result, selection.source, selection.identity)}`,
      result.outputTruncated ? "Output was truncated to the configured limit; the tail is shown." : "",
      result.error ? `Error: ${result.error}` : "",
      "Child output:",
      result.output || "(no output)",
    ].filter(Boolean).join("\n");
    const details: Record<string, unknown> = {
      dispatchId,
      status: result.status,
      agent: agent.name,
      selectedModel: selection.identity,
      appliedModel: result.appliedModel,
      ...(result.servedModel ? { servedModel: result.servedModel } : {}),
      selectionSource: selection.source,
      output: result.output,
      error: result.error,
      ...(result.outputTruncated ? { outputTruncated: true } : {}),
    };
    update(options, dispatchId, "settled", `${result.status}; child ended`, { outcome: result.status });
    if (result.status !== "success") throw new DispatchFailure({ text, details });
    return { content: [{ type: "text", text }], details };
  } catch (error) {
    // A trial claimed before the runner threw is released untested; a run that
    // completed already released/consumed it inside recordChildHealth.
    if (trialClaimed && selectedIdentity) {
      health.abandonTrial(modelKey(selectedIdentity));
      trialClaimed = false;
    }
    const cancelled = controller.signal.aborted || (error instanceof AdmissionError && error.code === "cancelled");
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    if (!receiptAttempted) {
      receiptAttempted = true;
      const outcome = cancelled ? "cancelled" : "launch-error";
      await writeSafeReceipt(config, {
        dispatchId,
        ...(options.decisionId ? { decisionId: options.decisionId } : {}),
        agent: agent.name,
        ...(selectedIdentity ? { identity: selectedIdentity } : {}),
        ...(selectedSource ? { source: selectedSource } : {}),
        preference: config.preference,
        eligibleIds,
        profileVersion: profileVersion(config),
        outcome,
        errorCategory: selectedIdentity ? "execution" : "selection",
        routeTrace: traceFor(outcome),
      }, (receiptMessage) => ctx.ui.notify(receiptMessage, "warning"));
    }
    if (error instanceof DispatchFailure) throw error;
    if (cancelled) throw new DispatchFailure({ text: `Dispatch ${dispatchId}: cancelled`, details: { dispatchId, status: "cancelled" } });
    throw new DispatchFailure({ text: `Dispatch ${dispatchId}: launch-error\n${message}`, details: { dispatchId, status: "launch-error", error: message } });
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    options.unregisterController(controller);
    lease?.settle(blockedReason);
  }
}

export function validateAssignment(config: DelegateConfig, assignment: AssignmentInput): void {
  if (assignment.task.trim() === "") throw new DispatchFailure({ text: "task must not be empty", details: { status: "launch-error", error: "empty-task" } });
  if (assignment.task.length > config.limits.maxTaskChars) throw new DispatchFailure({ text: `task exceeds ${config.limits.maxTaskChars} characters`, details: { status: "launch-error", error: "task-too-large" } });
  if (assignment.context && assignment.context.length > config.limits.maxContextChars) throw new DispatchFailure({ text: `context exceeds ${config.limits.maxContextChars} characters`, details: { status: "launch-error", error: "context-too-large" } });
  if (assignment.expectedOutput && assignment.expectedOutput.length > config.limits.maxExpectedOutputChars) throw new DispatchFailure({ text: `expectedOutput exceeds ${config.limits.maxExpectedOutputChars} characters`, details: { status: "launch-error", error: "expected-output-too-large" } });
}

export function validateConfiguredChildTools(agent: TrustedAgent): void {
  const invalid = agent.tools.filter((tool) => tool === "delegate_task" || (!CHILD_TOOLS.has(tool) && (agent.childExtensions?.length ?? 0) === 0));
  if (invalid.length > 0) throw new DispatchFailure({ text: `Child tools are not approved: ${invalid.join(", ")}`, details: { status: "launch-error", error: "invalid-child-tools" } });
}

// Keep the CandidateProfile type referenced for consumers that imported it from here historically.
export type { CandidateProfile };
