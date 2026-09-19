import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdmissionError, type DispatchAdmission } from "./admission.js";
import { resolveChildExtensions, validateProbedChildTools } from "./child-extensions.js";
import { CHILD_TOOLS } from "./config.js";
import { JevSelector } from "./jev.js";
import { quotaSelectorOptions } from "./selector-options.js";
import { resolveCandidateData } from "./live-data.js";
import { isKnownUnreachable, readProbeCache } from "./reachability.js";
import { PiProcessSpawner, probePiExtensionTools } from "./pi-process.js";
import { appendReceipt, defaultReceiptPath } from "./receipt-store.js";
import { buildReceipt, dispatchSummary, sanitizeError } from "./receipts.js";
import { ChildRunner } from "./runner.js";
import { selectModel } from "./selection.js";
import { modelKey, type CandidateProfile, type ComplexityLevel, type DelegateConfig, type DelegateRequest, type JevChoiceInput, type ModelIdentity, type SelectionResult, type TrustedAgent } from "./types.js";

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
  registerController: (controller: AbortController) => void;
  unregisterController: (controller: AbortController) => void;
  markDelegated: () => void;
}

function eligibleCandidates(config: DelegateConfig, agent: TrustedAgent, ctx: ExtensionContext): CandidateProfile[] {
  return config.candidates
    .filter((candidate) => {
      const model = ctx.modelRegistry.find(candidate.identity.provider, candidate.identity.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return false;
      if (agent.tools.includes("delegate_task")) return false;
      // Exclusion happens HERE, before the chooser is asked: a model the
      // provider will refuse must not consume a decision or a dispatch.
      if (probeExcludes(candidate.identity)) return false;
      return true;
    })
    // Enrich each eligible candidate with the provider's own published facts.
    // Without this the chooser sees only a prose description and a hand-written
    // price — measured wrong for 9 of 12 candidates, one by 20x — so it routes
    // on invented numbers.
    .map((candidate) => applyLiveData(candidate, ctx));
}

/** Overlay provider-registered cost/limits onto a configured candidate. */
function applyLiveData(candidate: CandidateProfile, ctx: ExtensionContext): CandidateProfile {
  try {
    const data = resolveCandidateData(candidate.identity, candidate, ctx.modelRegistry);
    return {
      ...candidate,
      ...(data.cost ? { cost: data.cost } : {}),
      costSource: data.costSource,
      ...(data.contextWindow !== undefined ? { contextWindow: data.contextWindow } : {}),
      ...(data.maxOutputTokens !== undefined ? { maxOutputTokens: data.maxOutputTokens } : {}),
      ...(data.reasoning !== undefined ? { reasoning: data.reasoning } : {}),
      ...(data.inputModalities ? { inputModalities: data.inputModalities } : {}),
    };
  } catch {
    // Provider data is an enhancement, never a launch prerequisite: a registry
    // that misbehaves must degrade to the configured profile, not fail dispatch.
    return candidate;
  }
}

/**
 * Whether the last reachability probe found this model unserved. Reading the
 * cache is synchronous and cheap, so this runs on the dispatch path without
 * adding latency. A model with no probe entry is treated as reachable — absence
 * of evidence must not silently shrink the pool.
 */
function probeExcludes(identity: ModelIdentity): boolean {
  try {
    return isKnownUnreachable(identity, readProbeCache());
  } catch {
    return false;
  }
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
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  options.registerController(controller);

  let selectedIdentity: ModelIdentity | undefined;
  let selectedSource: SelectionResult["source"] | undefined;
  let eligibleIds: string[] = [];
  let receiptAttempted = false;
  let blockedReason: string | undefined;
  let lease: Awaited<ReturnType<DispatchAdmission["acquire"]>> | undefined;

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

    const candidates = eligibleCandidates(config, agent, ctx);
    eligibleIds = candidates.map((candidate) => modelKey(candidate.identity));
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
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
      selectionMode: config.selection,
      allowExternalSensing: config.allowExternalSensing,
      selectionDeadlineMs: config.limits.selectionDeadlineMs,
    };
    const selection = await selectModel(request, {
      choose: (input: JevChoiceInput) => new JevSelector(quotaSelectorOptions(config.limits.selectionDeadlineMs, config.costMode)).choose(input),
      signal: controller.signal,
    });
    selectedIdentity = selection.identity;
    selectedSource = selection.source;
    const revalidated = eligibleCandidates(config, agent, ctx);
    if (!revalidated.some((candidate) => modelKey(candidate.identity) === modelKey(selection.identity))) {
      throw new Error(`Selected model ${modelKey(selection.identity)} is no longer eligible`);
    }

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
    const cancelled = controller.signal.aborted || (error instanceof AdmissionError && error.code === "cancelled");
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    if (!receiptAttempted) {
      receiptAttempted = true;
      await writeSafeReceipt(config, {
        dispatchId,
        ...(options.decisionId ? { decisionId: options.decisionId } : {}),
        agent: agent.name,
        ...(selectedIdentity ? { identity: selectedIdentity } : {}),
        ...(selectedSource ? { source: selectedSource } : {}),
        preference: config.preference,
        eligibleIds,
        profileVersion: profileVersion(config),
        outcome: cancelled ? "cancelled" : "launch-error",
        errorCategory: selectedIdentity ? "execution" : "selection",
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
