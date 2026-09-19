import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DispatchAdmission } from "./admission.js";
import { loadConfig, CONFIG_FILE_NAME, CHILD_TOOLS } from "./config.js";
import { JevSelector } from "./jev.js";
import { DelegationGate, JevDelegationSelector, type DelegationDecision, type DelegationGateInput } from "./gate.js";
import { ModeController, policyForMode } from "./mode.js";
import { PiProcessSpawner } from "./pi-process.js";
import { appendReceipt, defaultDecisionReceiptPath, defaultReceiptPath } from "./receipt-store.js";
import { buildDecisionReceipt, buildReceipt, classifyError, dispatchSummary, sanitizeError } from "./receipts.js";
import { selectModel } from "./selection.js";
import { ChildRunner } from "./runner.js";
import { modelKey, type CandidateProfile, type DelegateConfig, type DelegateRequest, type JevChoiceInput, type JevChoiceAnswer, type ModelIdentity, type SelectionResult, type TrustedAgent } from "./types.js";

const TOOL_NAME = "delegate_task";

const DelegateTaskParams = Type.Object({
  agent: Type.String({ description: "Name of a configured trusted child agent" }),
  task: Type.String({ description: "One self-contained assignment for the child" }),
  expectedOutput: Type.Optional(Type.String({ description: "Optional acceptance or output description" })),
  context: Type.Optional(Type.String({ description: "Optional bounded context; not a permission grant" })),
});
type DelegateTaskParams = Static<typeof DelegateTaskParams>;

/** Error thrown so Pi's tool-result machinery marks the call as failed (F12). */
class DelegationToolError extends Error {
  constructor(readonly payload: { text: string; details: Record<string, unknown> }) {
    super(payload.text);
    this.name = "DelegationToolError";
  }
}

function configuredAgent(config: DelegateConfig, name: string): TrustedAgent {
  const agent = config.agents[name];
  if (!agent) throw new DelegationToolError({ text: `Unknown trusted agent "${name}"; configure it in ${CONFIG_FILE_NAME}`, details: { status: "launch-error", error: `unknown-agent:${name}` } });
  const pin = config.agentPins[name] ?? agent.model;
  return pin ? { ...agent, model: pin } : agent;
}

function validateAssignment(config: DelegateConfig, params: DelegateTaskParams): void {
  if (params.task.trim() === "") throw new DelegationToolError({ text: "task must not be empty", details: { status: "launch-error", error: "empty-task" } });
  if (params.task.length > config.limits.maxTaskChars) throw new DelegationToolError({ text: `task exceeds ${config.limits.maxTaskChars} characters`, details: { status: "launch-error", error: "task-too-large" } });
  if (params.context && params.context.length > config.limits.maxContextChars) {
    throw new DelegationToolError({ text: `context exceeds ${config.limits.maxContextChars} characters`, details: { status: "launch-error", error: "context-too-large" } });
  }
  if (params.expectedOutput && params.expectedOutput.length > config.limits.maxExpectedOutputChars) {
    throw new DelegationToolError({ text: `expectedOutput exceeds ${config.limits.maxExpectedOutputChars} characters`, details: { status: "launch-error", error: "expected-output-too-large" } });
  }
}

function eligibleCandidates(config: DelegateConfig, agent: TrustedAgent, ctx: ExtensionContext): CandidateProfile[] {
  const candidates: CandidateProfile[] = [];
  for (const candidate of config.candidates) {
    const model = ctx.modelRegistry.find(candidate.identity.provider, candidate.identity.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
    if (agent.tools.some((tool) => !CHILD_TOOLS.has(tool) || tool === TOOL_NAME)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function validateChildTools(agent: TrustedAgent): string[] {
  const invalid = agent.tools.filter((tool) => !CHILD_TOOLS.has(tool) || tool === TOOL_NAME);
  if (invalid.length > 0) throw new DelegationToolError({ text: `Child tools are not approved: ${invalid.join(", ")}`, details: { status: "launch-error", error: "invalid-child-tools" } });
  return [...new Set(agent.tools)];
}

/**
 * Profile version covers full profile content, not just identity (IDs alone
 * cannot detect changed prices/capabilities text).
 */
function profileVersion(config: DelegateConfig): string {
  const digest = config.candidates
    .map((candidate) => JSON.stringify(candidate))
    .sort()
    .join("|");
  return `v1:${digest}`;
}

/**
 * Shared launchability resolver used by BOTH the gate and dispatch (F09):
 * the gate's "childAvailable" must mean dispatch can actually launch a child
 * under the same precedence rules.
 */
function launchableChild(
  config: DelegateConfig,
  agentName: string,
  ctx: ExtensionContext,
  jevChoose?: (input: JevChoiceInput) => Promise<JevChoiceAnswer>,
): { candidates: CandidateProfile[]; agent: TrustedAgent; model: ModelIdentity } | undefined {
  const agent = config.agents[agentName];
  if (!agent) return undefined;
  try {
    validateChildTools(agent);
  } catch {
    return undefined;
  }
  const pinned = config.agentPins[agentName] ?? agent.model;
  const effectiveAgent = pinned ? { ...agent, model: pinned } : agent;
  const candidates = eligibleCandidates(config, effectiveAgent, ctx);
  if (candidates.length === 0) return undefined;
  const request: DelegateRequest = {
    agent: effectiveAgent,
    task: "availability probe",
    preference: config.preference,
    candidates,
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    selectionMode: config.selection,
    allowExternalSensing: config.allowExternalSensing,
    selectionDeadlineMs: config.limits.selectionDeadlineMs,
  };
  const model = resolveLaunchModelImpl(request, jevChoose);
  if (!model) return undefined;
  return { candidates, agent: effectiveAgent, model };
}

function resolveLaunchModelImpl(request: DelegateRequest, jevChoose?: (input: JevChoiceInput) => Promise<JevChoiceAnswer>): ModelIdentity | undefined {
  const pin = request.agent.model;
  if (pin) return request.candidates.some((candidate) => modelKey(candidate.identity) === modelKey(pin)) ? pin : undefined;
  if (request.selectionMode === "fixed" || !request.allowExternalSensing) {
    if (request.defaultModel) {
      return request.candidates.some((candidate) => modelKey(candidate.identity) === modelKey(request.defaultModel!)) ? request.defaultModel : undefined;
    }
    return request.candidates.length > 0 ? request.candidates[0]!.identity : undefined;
  }
  if (request.candidates.length === 0) return undefined;
  if (request.candidates.length === 1) return request.candidates[0]!.identity;
  // Jev mode with multiple candidates: usable only if a fallback default is
  // eligible for sensor failures, or a chooser is wired for live selection.
  if (request.defaultModel && request.candidates.some((candidate) => modelKey(candidate.identity) === modelKey(request.defaultModel!))) {
    return request.defaultModel;
  }
  if (jevChoose) return request.candidates[0]!.identity; // chooser live; dispatch revalidates anyway
  return undefined;
}

function gateCandidates(
  config: DelegateConfig,
  ctx: ExtensionContext,
  jevChoose?: (input: JevChoiceInput) => Promise<JevChoiceAnswer>,
): { candidates: CandidateProfile[]; childAvailable: boolean; agentNames: string[] } {
  const agentNames: string[] = [];
  let anyLaunchable = false;
  for (const name of Object.keys(config.agents)) {
    if (launchableChild(config, name, ctx, jevChoose)) {
      agentNames.push(name);
      anyLaunchable = true;
    }
  }
  const candidates = config.candidates.filter((candidate) => {
    const model = ctx.modelRegistry.find(candidate.identity.provider, candidate.identity.id);
    return Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model));
  });
  return { candidates, childAvailable: anyLaunchable, agentNames };
}

function parentCapabilities(ctx: ExtensionContext): string[] {
  const model = ctx.model as ({ provider?: string; id?: string; reasoning?: boolean } | undefined);
  return [
    ...(model?.provider ? [`provider:${model.provider}`] : ["model:unknown"]),
    ...(model?.id ? [`model:${model.id}`] : ["id:unknown"]),
    ...(model?.reasoning ? ["reasoning"] : []),
    ...(ctx.getSystemPrompt?.().length ? ["current-context"] : []),
  ];
}

function buildGateInput(config: DelegateConfig, mode: ModeController, ctx: ExtensionContext, prompt: string, jevChoose?: (input: JevChoiceInput) => Promise<JevChoiceAnswer>): DelegationGateInput {
  const available = gateCandidates(config, ctx, jevChoose);
  const model = ctx.model as ({ provider?: string; id?: string } | undefined);
  return {
    // Bounded gate prompt (F11): oversized prompts are truncated for sensing,
    // and the truncation is disclosed to the sensor.
    prompt: prompt.length > config.limits.maxGatePromptChars
      ? `${prompt.slice(0, config.limits.maxGatePromptChars)}\n[prompt truncated to ${config.limits.maxGatePromptChars} characters]`
      : prompt,
    policy: config.delegationDecision,
    baseMode: mode.current(),
    baseTools: mode.baseToolNames(),
    preference: config.preference,
    parent: {
      capabilities: parentCapabilities(ctx),
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.id ? { id: model.id } : {}),
    },
    candidates: available.candidates,
    childAvailable: available.childAvailable,
    childAgentNames: available.agentNames,
    allowExternalSensing: config.allowExternalSensing,
    deadlineMs: config.limits.selectionDeadlineMs,
    maxGatePromptChars: config.limits.maxGatePromptChars,
  };
}

function statusText(config: DelegateConfig, mode: string): string {
  const candidates = config.candidates.map((candidate) => modelKey(candidate.identity)).join(", ") || "none";
  const agents = Object.keys(config.agents).join(", ") || "none";
  return `pi-delegateau: mode=${mode}, selection=${config.selection}, preference=${config.preference}, agents=${agents}, configured candidates=${candidates}, Jev disclosure=${config.allowExternalSensing ? "allowed" : "prohibited"}`;
}

async function writeSafeReceipt(config: DelegateConfig, input: Parameters<typeof buildReceipt>[0], notify: (message: string) => void): Promise<void> {
  try {
    await appendReceipt(config.receiptPath ?? defaultReceiptPath(), buildReceipt(input));
  } catch (error) {
    notify(`Receipt warning: ${sanitizeError(error instanceof Error ? error.message : String(error))}`);
  }
}

async function writeDecisionReceipt(config: DelegateConfig, decision: DelegationDecision, outcome: string, notify: (message: string) => void): Promise<void> {
  try {
    await appendReceipt(config.decisionReceiptPath ?? defaultDecisionReceiptPath(), buildDecisionReceipt(decision, outcome));
  } catch (error) {
    notify(`Decision receipt warning: ${sanitizeError(error instanceof Error ? error.message : String(error))}`);
  }
}

/** Build the memoized gate selector lazily and defensively (F01). */
function buildGateSelector(config: DelegateConfig): JevDelegationSelector | undefined {
  // Only construct when a policy actually needs sensing; construction
  // failures inside the gate become fail-closed decisions, never throws
  // that escape the hook boundary.
  if (config.delegationDecision === "manual") return undefined;
  if (!config.allowExternalSensing) return undefined;
  try {
    return new JevDelegationSelector({ timeoutMs: config.limits.selectionDeadlineMs });
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  const admission = new DispatchAdmission();
  const mode = new ModeController({
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
    getAllTools: () => pi.getAllTools(),
  });
  const activeDispatches = new Set<AbortController>();
  const gate = new DelegationGate();
  let shadowedDelegateTaskCalls = false;

  // Duplicate-tool guard (F20/SPEC §3): Pi's loader keeps the FIRST
  // registration per name and only reports collisions as diagnostics, so a
  // competing extension silently shadows this one. Pi 0.85.1 offers no
  // load-time seam to read existing registrations from inside a factory
  // (getAllTools throws "runtime not initialized" until bind), so this check
  // is best-effort for hosts that expose it, plus a runtime shadow check in
  // the tool_call hook below. Documented limitation: on stock Pi a competitor
  // that registers first shadows this extension; Pi's diagnostics warn.
  try {
    const existing = pi.getAllTools();
    const foreign = existing.filter((tool) => tool.name === TOOL_NAME && (tool as any).sourceInfo?.source !== undefined);
    if (foreign.length > 0) {
      const owner = (foreign[0] as any).sourceInfo?.path ?? (foreign[0] as any).sourceInfo?.source ?? "another extension";
      throw new Error(`pi-delegateau: tool "${TOOL_NAME}" is already registered by ${owner}; refusing to double-register. Remove the competing extension or rename it.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("double-register")) throw error;
    // Expected on Pi 0.85.1 (runtime not bound during load): fall through.
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Delegate task",
    description: "Delegate one self-contained assignment to a configured trusted child. The child runs in isolated context on one selected model.",
    promptSnippet: "Delegate one self-contained assignment to a trusted child agent",
    promptGuidelines: ["Use delegate_task for an assignment that should run on a separately selected child model; the parent owns acceptance."],
    parameters: DelegateTaskParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Project trust gate (F03): repository-controlled executable policy may
      // only be consumed from a project the host has marked trusted.
      if (typeof (ctx as any).isProjectTrusted === "function" && !(ctx as any).isProjectTrusted()) {
        throw new DelegationToolError({
          text: "Delegation is unavailable: this project is not trusted. Trust the project in Pi (or move delegateau.json to a trusted location) first.",
          details: { status: "launch-error", error: "project-not-trusted" },
        });
      }
      const config = loadConfig(ctx.cwd);
      validateAssignment(config, params);
      const agent = configuredAgent(config, params.agent);
      const tools = validateChildTools(agent);
      if (signal?.aborted) {
        throw new DelegationToolError({ text: "Delegation cancelled before launch", details: { status: "cancelled" } });
      }
      const lease = admission.acquire();
      if (!lease.ok) {
        throw new DelegationToolError({ text: `Busy: ${lease.reason}`, details: { status: "busy" } });
      }

      const dispatchId = randomUUID();
      // Capture the owning decision at admission (F13): later gate changes
      // cannot steal or lose this dispatch's link.
      const owningDecision = gate.current();
      const owningDecisionId = owningDecision?.decisionId;
      let selectedIdentity: SelectionResult["identity"] | undefined;
      let selectedSource: SelectionResult["source"] | undefined;
      let eligibleIds: string[] = [];
      let receiptAttempted = false;
      const dispatchController = new AbortController();
      const forwardAbort = () => dispatchController.abort();
      if (signal?.aborted) dispatchController.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      activeDispatches.add(dispatchController);
      try {
        onUpdate?.({ content: [{ type: "text", text: `[${dispatchId}] resolving eligible models...` }], details: { dispatchId, status: "selecting" } });
        const candidates = eligibleCandidates(config, agent, ctx);
        eligibleIds = candidates.map((candidate) => modelKey(candidate.identity));
        const request: DelegateRequest = {
          agent,
          task: params.task,
          ...(params.expectedOutput ? { expectedOutput: params.expectedOutput } : {}),
          ...(params.context ? { context: params.context } : {}),
          preference: config.preference,
          candidates,
          ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
          selectionMode: config.selection,
          allowExternalSensing: config.allowExternalSensing,
          selectionDeadlineMs: config.limits.selectionDeadlineMs,
        };
        const chooser = {
          choose: (input: JevChoiceInput) => new JevSelector({ timeoutMs: config.limits.selectionDeadlineMs }).choose(input),
          signal: dispatchController.signal,
        };
        const selection: SelectionResult = await selectModel(request, chooser);
        selectedIdentity = selection.identity;
        selectedSource = selection.source;

        const revalidated = eligibleCandidates(config, agent, ctx);
        if (!revalidated.some((candidate) => modelKey(candidate.identity) === modelKey(selection.identity))) {
          throw new Error(`Selected model ${modelKey(selection.identity)} is no longer eligible`);
        }
        const runner = new ChildRunner(new PiProcessSpawner({ ...(config.piCommand ? { command: config.piCommand } : {}) }));
        onUpdate?.({ content: [{ type: "text", text: `[${dispatchId}] ${dispatchSummaryPreview(selection)}; child starting...` }], details: { dispatchId, status: "running", selection } });
        const result = await runner.run(
          {
            model: selection.identity,
            task: params.task,
            ...(params.expectedOutput ? { expectedOutput: params.expectedOutput } : {}),
            ...(params.context ? { context: params.context } : {}),
            instructions: agent.instructions,
            tools,
            cwd: ctx.cwd,
            ...(config.childThinking ? { thinking: config.childThinking } : {}),
            signal: dispatchController.signal,
            wallTimeMs: config.limits.childWallTimeMs,
            maxTurns: config.limits.childMaxTurns,
            maxOutputChars: config.limits.childOutputChars,
          },
          (text) => onUpdate?.({ content: [{ type: "text", text: `[${dispatchId}] ${text}` }], details: { dispatchId, status: "running" } }),
        );
        receiptAttempted = true;
        // Truthful admission semantics (F04/F08): a started child without
        // observed exit, or a group we could not confirm clean, blocks the
        // next dispatch instead of silently reopening.
        if (result.processStarted && (!result.observedExit || result.groupCleaned === false)) {
          lease.blocked("child exit or process-group cleanup not observed; manual recovery required");
        }
        // Only claim delegated execution once a child actually started (F13).
        if (result.processStarted) gate.markExecution("delegated");
        await writeSafeReceipt(config, {
          dispatchId,
          ...(owningDecisionId ? { decisionId: owningDecisionId } : {}),
          agent: agent.name,
          identity: result.appliedModel,
          ...(result.servedModel ? { servedModel: result.servedModel } : {}),
          ...(selection.identity ? { requestedModel: selection.identity } : {}),
          source: selection.source,
          preference: config.preference,
          eligibleIds: candidates.map((candidate) => modelKey(candidate.identity)),
          profileVersion: profileVersion(config),
          outcome: result.status,
          ...(selection.probabilities ? { selectionProbabilities: selection.probabilities } : {}),
          ...(selection.confidence !== undefined ? { confidence: selection.confidence } : {}),
          ...(selection.chooserLatencyMs !== undefined ? { chooserLatencyMs: selection.chooserLatencyMs } : {}),
          ...(selection.cause ? { fallbackCause: classifyError(selection.cause) ?? "sensor-error" } : {}),
          usage: { chooser: selection.usage, child: result.usage },
          ...(result.error ? { errorCategory: result.status } : {}),
          ...(result.groupCleaned !== undefined ? { groupCleaned: result.groupCleaned } : {}),
          ...(result.outputTruncated ? { outputTruncated: true } : {}),
        }, (message) => ctx.ui.notify(message, "warning"));
        const summary = dispatchSummary(result, selection.source, selection.identity);
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
        const text = [
          `Dispatch ${dispatchId}: ${result.status}`,
          `Agent: ${agent.name}`,
          `Selection: ${summary}`,
          result.outputTruncated ? "Output was truncated to the configured limit; the tail is shown." : "",
          result.error ? `Error: ${result.error}` : "",
          "Child output:",
          result.output || "(no output)",
        ].filter(Boolean).join("\n");
        // Non-success results are surfaced as Pi tool errors via the thrown
        // DelegationToolError (F12): Pi marks fulfilled executes as
        // non-errors, so the error channel must be the exception.
        if (result.status !== "success") {
          throw new DelegationToolError({ text, details });
        }
        return { content: [{ type: "text", text }], details };
      } catch (error) {
        const message = sanitizeError(error instanceof Error ? error.message : String(error));
        if (!receiptAttempted) {
          receiptAttempted = true;
          await writeSafeReceipt(config, {
            dispatchId,
            ...(owningDecisionId ? { decisionId: owningDecisionId } : {}),
            agent: agent.name,
            ...(selectedIdentity ? { identity: selectedIdentity } : {}),
            ...(selectedSource ? { source: selectedSource } : {}),
            preference: config.preference,
            eligibleIds,
            profileVersion: profileVersion(config),
            outcome: dispatchController.signal.aborted ? "cancelled" : "launch-error",
            errorCategory: selectedIdentity ? "execution" : "selection",
          }, (receiptMessage) => ctx.ui.notify(receiptMessage, "warning"));
        }
        if (dispatchController.signal.aborted) {
          throw new DelegationToolError({ text: `Dispatch ${dispatchId}: cancelled`, details: { dispatchId, status: "cancelled" } });
        }
        if (error instanceof DelegationToolError) throw error;
        throw new DelegationToolError({ text: `Dispatch ${dispatchId}: launch-error\n${message}`, details: { dispatchId, status: "launch-error", error: message } });
      } finally {
        signal?.removeEventListener("abort", forwardAbort);
        activeDispatches.delete(dispatchController);
        lease.release();
      }
    },
  });

  pi.registerCommand("delegateau", {
    description: "Show or change pi-delegateau status and parent delegation mode",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const command = words[0] ?? "status";
      const config = loadConfig(ctx.cwd);
      mode.setAllowedTools("delegate-execution", config.allowedParentTools.delegateExecution);
      mode.setAllowedTools("coordinator-only", config.allowedParentTools.coordinatorOnly);
      if (command === "status") {
        const decision = gate.current();
        const decisionText = decision ? `, gate=${decision.status}/${decision.source}${decision.recommendation ? `:${decision.recommendation}` : ""}` : "";
        // Admission visibility (F23): a blocked dispatch is a standing state
        // the user must be able to see from status, not just a busy error on
        // the next attempt.
        const busy = admission.isBusy();
        const busyText = busy ? `, admission=busy${admission.reason() ? ` (${admission.reason()})` : ""}` : ", admission=idle";
        const shadowText = shadowedDelegateTaskCalls ? ", tool-shadowing=suspected (delegate_task resolved outside this extension; check for a competing extension)" : "";
        ctx.ui.notify(`${statusText(config, mode.current())}, delegation decision=${config.delegationDecision}${decisionText}${busyText}${shadowText}`, "info");
        return;
      }
      if (command === "override" || ["local", "delegate", "manual"].includes(command)) {
        const requested = (command === "override" ? words[1] : command) as "local" | "delegate" | "manual" | undefined;
        if (!requested || !["local", "delegate", "manual"].includes(requested)) {
          ctx.ui.notify("Usage: /delegateau override [local|delegate|manual]", "warning");
          return;
        }
        try {
          const decision = gate.override(requested);
          mode.setRequestRestriction(decision.restriction);
          await writeDecisionReceipt(config, decision, "user-override", (message) => ctx.ui.notify(message, "warning"));
          ctx.ui.notify(`pi-delegateau: current-request override ${requested}`, "info");
        } catch (error) {
          ctx.ui.notify(`pi-delegateau: ${sanitizeError(error instanceof Error ? error.message : String(error))}`, "warning");
        }
        return;
      }
      if (command === "disable") {
        const result = mode.deactivate();
        ctx.ui.notify(result.ok ? "pi-delegateau: normal mode" : `pi-delegateau: ${result.reason}`, result.ok ? "info" : "warning");
        return;
      }
      const requested = command === "enable" ? (words[1] as "delegate-execution" | "coordinator-only" | undefined) ?? config.mode : command;
      if (!["normal", "delegate-execution", "coordinator-only"].includes(requested)) {
        ctx.ui.notify("Usage: /delegateau status | enable [delegate-execution|coordinator-only] | disable | delegate-execution | coordinator-only", "warning");
        return;
      }
      const result = mode.activate(requested as "normal" | "delegate-execution" | "coordinator-only");
      ctx.ui.notify(result.ok ? `pi-delegateau: ${requested} mode` : `pi-delegateau: ${result.reason}`, result.ok ? "info" : "warning");
    },
  });

  pi.on("agent_start", () => mode.setBusy(true));
  pi.on("agent_settled", async (_event, ctx) => {
    mode.setBusy(false);
    const decision = gate.current();
    // Receipt/cleanup must not depend on a config re-read succeeding (F12-
    // adjacent stranding): if the decision exists, settle and clear FIRST,
    // then attempt the receipt write.
    if (decision) {
      gate.settle();
      mode.clearRequestRestriction();
      const outcome = decision.execution === "none" ? "no-execution" : decision.execution;
      try {
        const config = loadConfig(ctx.cwd);
        await writeDecisionReceipt(config, decision, outcome, (message) => ctx.ui.notify(message, "warning"));
      } catch (error) {
        ctx.ui.notify(`pi-delegateau: decision receipt not written: ${sanitizeError(error instanceof Error ? error.message : String(error))}`, "warning");
      }
    } else {
      // Even with no active decision, make sure no stale restriction leaks
      // into the next request (F05 cleanup independence).
      gate.settle();
      mode.clearRequestRestriction();
    }
  });
  pi.on("tool_call", async (event) => {
    // Runtime shadow check (F20): if a competing extension registered
    // delegate_task first, the runner routes calls to ITS definition and our
    // execute() never runs — silently. A delegate_task call that does not
    // originate from this extension instance's execute() path is detectable
    // because our execute() sets this flag before returning; a call observed
    // here without a matching in-flight dispatch means the shadowed tool was
    // invoked. Status surface reports it; behavior stays fail-safe (no
    // delegation is attributed to this extension).
    if (event.toolName === TOOL_NAME) shadowedDelegateTaskCalls = true;
    const result = mode.guard(event.toolName);
    // A call that PAST the guard is observed parent tool activity (F13/F15
    // distinction): an unblocked non-delegation call honestly marks "local".
    // Delegated execution is only claimed after a child process actually
    // starts, inside the tool's execute() — a call name alone proves nothing.
    if (!result && event.toolName !== TOOL_NAME) gate.markExecution("local");
    return result;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    // Fail-closed initialization (F01): config reads AND sensor construction
    // both sit inside the guarded region, so any failure still installs an
    // enforced restriction before execution rather than degrading silently.
    let config: DelegateConfig;
    try {
      config = loadConfig(ctx.cwd);
    } catch (error) {
      // A config read failure is total: we cannot even know the policy.
      // Block protected execution (the safe default for enforced setups)
      // and tell the user plainly.
      ctx.ui.notify(`pi-delegateau: ${CONFIG_FILE_NAME} is unreadable (${sanitizeError(error instanceof Error ? error.message : String(error))}); protected execution is blocked for this request. Fix the configuration or use /delegateau disable.`, "warning");
      mode.setRequestRestriction("blocked");
      return undefined;
    }
    mode.setAllowedTools("delegate-execution", config.allowedParentTools.delegateExecution);
    mode.setAllowedTools("coordinator-only", config.allowedParentTools.coordinatorOnly);
    let decision: DelegationDecision;
    try {
      const selector = buildGateSelector(config);
      const jevChoose = config.selection === "jev" && config.allowExternalSensing
        ? (input: JevChoiceInput) => new JevSelector({ timeoutMs: config.limits.selectionDeadlineMs }).choose(input)
        : undefined;
      decision = await gate.ensure(buildGateInput(config, mode, ctx, event.prompt, jevChoose), selector);
    } catch (error) {
      ctx.ui.notify(`pi-delegateau: delegation gate failed (${sanitizeError(error instanceof Error ? error.message : String(error))}); ${config.delegationDecision === "jev-enforce" ? "protected execution is blocked for this request" : "continuing in manual mode"}`, "warning");
      if (config.delegationDecision === "jev-enforce") {
        mode.setRequestRestriction("blocked");
      }
      const current = gate.current();
      if (current) {
        const outcome = current.execution === "none" ? "no-execution" : current.execution;
        await writeDecisionReceipt(config, current, outcome, (message) => ctx.ui.notify(message, "warning")).catch(() => undefined);
      }
      return undefined;
    }
    mode.setRequestRestriction(decision.restriction);
    await writeDecisionReceipt(config, decision, "decision", (message) => ctx.ui.notify(message, "warning"));
    const additions: string[] = [];
    const current = mode.current();
    if (current !== "normal") additions.push(`# DELEGAU MODE (active)\n${policyForMode(current).prompt}`);
    if (config.delegationDecision === "jev-suggest") {
      additions.push(`# DELEGATION RECOMMENDATION\n${decision.recommendation ? `Jev recommends ${decision.recommendation}.` : "Jev recommendation unavailable; decide manually."} This is advisory and you may disagree.`);
    } else if (config.delegationDecision === "jev-enforce") {
      additions.push(`# DELEGATION POLICY\n${decision.status === "blocked" ? "Protected execution is blocked until delegation policy recovers or you use an explicit current-request override." : decision.recommendation === "delegate" ? "Direct execution is restricted for this request; use delegate_task when execution is needed." : "The current request is permitted to execute under the existing base tool policy."}`);
    }
    return additions.length > 0 ? { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` } : undefined;
  });
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior !== "steer") return;
    // Material steering regenerates the decision (F05): the old decision is
    // invalidated and a replacement is ensured immediately, so the steered
    // work never runs under a stale restriction with no recovery path.
    const invalidated = gate.invalidate("material user steering");
    if (!invalidated) return;
    if (invalidated.policy === "jev-enforce") mode.setRequestRestriction("blocked");
    try {
      const config = loadConfig(ctx.cwd);
      await writeDecisionReceipt(config, invalidated, "cancelled", (message) => ctx.ui.notify(message, "warning"));
      const selector = buildGateSelector(config);
      const jevChoose = config.selection === "jev" && config.allowExternalSensing
        ? (input: JevChoiceInput) => new JevSelector({ timeoutMs: config.limits.selectionDeadlineMs }).choose(input)
        : undefined;
      const decision = await gate.ensure(buildGateInput(config, mode, ctx, event.text ?? "", jevChoose), selector);
      mode.setRequestRestriction(decision.restriction);
      await writeDecisionReceipt(config, decision, "decision", (message) => ctx.ui.notify(message, "warning"));
    } catch (error) {
      // Regeneration failed: keep the enforced restriction applied; the user
      // retains status/override/clarification recovery (F05).
      ctx.ui.notify(`pi-delegateau: delegation decision regeneration failed after steering (${sanitizeError(error instanceof Error ? error.message : String(error))})`, "warning");
    }
  });
  pi.on("session_start", (_event, ctx) => {
    gate.invalidate("session started");
    mode.clearRequestRestriction();
    const config = loadConfig(ctx.cwd);
    mode.setAllowedTools("delegate-execution", config.allowedParentTools.delegateExecution);
    mode.setAllowedTools("coordinator-only", config.allowedParentTools.coordinatorOnly);
    // Report the REAL mode, not an unconditional "normal" claim (F22-adjacent).
    ctx.ui.setStatus("pi-delegateau", `${mode.current()} mode; /delegateau status; gate=${config.delegationDecision}`);
  });
  pi.on("session_shutdown", () => {
    gate.invalidate("session shutdown");
    for (const controller of activeDispatches) controller.abort();
    mode.clearRequestRestriction();
    mode.setBusy(false);
  });
}

function dispatchSummaryPreview(selection: SelectionResult): string {
  return `${selection.source}: ${modelKey(selection.identity)}`;
}

export { DelegateTaskParams, CHILD_TOOLS };