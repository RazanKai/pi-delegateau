import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DispatchAdmission } from "./admission.js";
import { loadConfig, CONFIG_FILE_NAME } from "./config.js";
import { JevSelector } from "./jev.js";
import { ModeController, policyForMode } from "./mode.js";
import { PiProcessSpawner } from "./pi-process.js";
import { appendReceipt, defaultReceiptPath } from "./receipt-store.js";
import { buildReceipt, sanitizeError } from "./receipts.js";
import { selectModel } from "./selection.js";
import { ChildRunner } from "./runner.js";
import { modelKey, type CandidateProfile, type DelegateConfig, type DelegateRequest, type ModelIdentity, type SelectionResult, type TrustedAgent } from "./types.js";

const TOOL_NAME = "delegate_task";
const CHILD_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

const DelegateTaskParams = Type.Object({
  agent: Type.String({ description: "Name of a configured trusted child agent" }),
  task: Type.String({ description: "One self-contained assignment for the child" }),
  expectedOutput: Type.Optional(Type.String({ description: "Optional acceptance or output description" })),
  context: Type.Optional(Type.String({ description: "Optional bounded context; not a permission grant" })),
});
type DelegateTaskParams = Static<typeof DelegateTaskParams>;

function configuredAgent(config: DelegateConfig, name: string): TrustedAgent {
  const agent = config.agents[name];
  if (!agent) throw new Error(`Unknown trusted agent "${name}"; configure it in ${CONFIG_FILE_NAME}`);
  const pin = config.agentPins[name] ?? agent.model;
  return pin ? { ...agent, model: pin } : agent;
}

function validateAssignment(config: DelegateConfig, params: DelegateTaskParams): void {
  if (params.task.trim() === "") throw new Error("task must not be empty");
  if (params.task.length > config.limits.maxTaskChars) throw new Error(`task exceeds ${config.limits.maxTaskChars} characters`);
  if (params.context && params.context.length > config.limits.maxContextChars) {
    throw new Error(`context exceeds ${config.limits.maxContextChars} characters`);
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
  if (invalid.length > 0) throw new Error(`Child tools are not approved: ${invalid.join(", ")}`);
  return [...new Set(agent.tools)];
}

function profileVersion(config: DelegateConfig): string {
  return `v1:${config.candidates.map((candidate) => modelKey(candidate.identity)).sort().join(",")}`;
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

export default function (pi: ExtensionAPI): void {
  const admission = new DispatchAdmission();
  const mode = new ModeController({
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
    getAllTools: () => pi.getAllTools(),
  });
  const activeDispatches = new Set<AbortController>();

  pi.registerTool({
    name: TOOL_NAME,
    label: "Delegate task",
    description: "Delegate one self-contained assignment to a configured trusted child. The child runs in isolated context on one selected model.",
    promptSnippet: "Delegate one self-contained assignment to a trusted child agent",
    promptGuidelines: ["Use delegate_task for an assignment that should run on a separately selected child model; the parent owns acceptance."],
    parameters: DelegateTaskParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      validateAssignment(config, params);
      const agent = configuredAgent(config, params.agent);
      const tools = validateChildTools(agent);
      const lease = admission.acquire();
      if (!lease.ok) {
        return { content: [{ type: "text", text: `Busy: ${lease.reason}` }], details: { status: "busy" } };
      }

      const dispatchId = randomUUID();
      let selectedIdentity: SelectionResult["identity"] | undefined;
      let selectedSource: SelectionResult["source"] | undefined;
      let eligibleIds: string[] = [];
      let receiptAttempted = false;
      const dispatchController = new AbortController();
      const forwardAbort = () => dispatchController.abort();
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
          choose: (input: Parameters<JevSelector["choose"]>[0]) => new JevSelector({ timeoutMs: config.limits.selectionDeadlineMs }).choose(input),
          signal: dispatchController.signal,
        };
        const selection: SelectionResult = await selectModel(request, chooser);
        selectedIdentity = selection.identity;
        selectedSource = selection.source;

        const revalidated = eligibleCandidates(config, agent, ctx);
        if (!revalidated.some((candidate) => modelKey(candidate.identity) === modelKey(selection.identity))) {
          throw new Error(`Selected model ${modelKey(selection.identity)} is no longer eligible`);
        }
        const runner = new ChildRunner(new PiProcessSpawner());
        onUpdate?.({ content: [{ type: "text", text: `[${dispatchId}] ${selection.source}: ${modelKey(selection.identity)}; child starting...` }], details: { dispatchId, status: "running", selection } });
        const result = await runner.run(
          {
            model: selection.identity,
            task: params.task,
            ...(params.expectedOutput ? { expectedOutput: params.expectedOutput } : {}),
            ...(params.context ? { context: params.context } : {}),
            instructions: agent.instructions,
            tools,
            cwd: ctx.cwd,
            signal: dispatchController.signal,
            wallTimeMs: config.limits.childWallTimeMs,
            maxTurns: config.limits.childMaxTurns,
            maxOutputChars: config.limits.childOutputChars,
          },
          (text) => onUpdate?.({ content: [{ type: "text", text: `[${dispatchId}] ${text}` }], details: { dispatchId, status: "running" } }),
        );
        receiptAttempted = true;
        await writeSafeReceipt(config, {
          dispatchId,
          agent: agent.name,
          identity: result.appliedModel,
          source: selection.source,
          preference: config.preference,
          eligibleIds: candidates.map((candidate) => modelKey(candidate.identity)),
          profileVersion: profileVersion(config),
          outcome: result.status,
          ...(selection.probabilities ? { selectionProbabilities: selection.probabilities } : {}),
          ...(selection.confidence !== undefined ? { confidence: selection.confidence } : {}),
          ...(selection.chooserLatencyMs !== undefined ? { chooserLatencyMs: selection.chooserLatencyMs } : {}),
          usage: { chooser: selection.usage, child: result.usage },
          ...(result.error ? { errorCategory: result.status } : {}),
        }, (message) => ctx.ui.notify(message, "warning"));
        const applied = modelKey(result.appliedModel);
        const requested = modelKey(selection.identity);
        const substitution = applied === requested ? "" : `\nApplied model evidence: ${applied} (requested ${requested})`;
        return {
          content: [{ type: "text", text: [`Dispatch ${dispatchId}: ${result.status}`, `Agent: ${agent.name}`, `Selection: ${selection.source} (${requested})${substitution}`, result.error ? `Error: ${result.error}` : "", "Child output:", result.output || "(no output)"].filter(Boolean).join("\n") }],
          details: { dispatchId, status: result.status, agent: agent.name, selectedModel: selection.identity, appliedModel: result.appliedModel, selectionSource: selection.source, output: result.output, error: result.error },
        };
      } catch (error) {
        const message = sanitizeError(error instanceof Error ? error.message : String(error));
        if (!receiptAttempted) {
          receiptAttempted = true;
          await writeSafeReceipt(config, {
            dispatchId,
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
          return { content: [{ type: "text", text: `Dispatch ${dispatchId}: cancelled` }], details: { dispatchId, status: "cancelled" }, isError: true };
        }
        return { content: [{ type: "text", text: `Dispatch ${dispatchId}: launch-error\n${message}` }], details: { dispatchId, status: "launch-error", error: message }, isError: true };
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
        ctx.ui.notify(statusText(config, mode.current()), "info");
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
  pi.on("agent_settled", () => mode.setBusy(false));
  pi.on("tool_call", async (event) => mode.guard(event.toolName));
  pi.on("before_agent_start", async (event) => {
    const current = mode.current();
    if (current === "normal") return;
    return { systemPrompt: `${event.systemPrompt}\n\n# DELEGAU MODE (active)\n${policyForMode(current).prompt}` };
  });
  pi.on("session_start", (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    mode.setAllowedTools("delegate-execution", config.allowedParentTools.delegateExecution);
    mode.setAllowedTools("coordinator-only", config.allowedParentTools.coordinatorOnly);
    ctx.ui.setStatus("pi-delegateau", "normal mode; /delegateau status");
  });
  pi.on("session_shutdown", () => {
    for (const controller of activeDispatches) controller.abort();
    mode.setBusy(false);
  });
}

export { DelegateTaskParams, CHILD_TOOLS };
