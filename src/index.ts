import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DispatchAdmission } from "./admission.js";
import { loadConfig, resolveConfig, CONFIG_FILE_NAME, CHILD_TOOLS } from "./config.js";
import { benchmarkCachePath, benchmarkRecordKey, importBenchmarkFile, mergeBenchmarkReport, readBenchmarkCache, revalidateBenchmarkCache, writeBenchmarkCache } from "./benchmarks.js";
import { ARTIFICIAL_ANALYSIS_API_KEY_ENV, ARTIFICIAL_ANALYSIS_SOURCE, parseSourceModelMap, retrieveArtificialAnalysis } from "./benchmark-retrieval.js";
import { DispatchFailure, executeDispatch, validateAssignment, validateConfiguredChildTools, type AssignmentInput } from "./dispatch.js";
import { resolveEligibleCandidates } from "./eligibility.js";
import { HealthStore } from "./health-store.js";
import { JevSelector } from "./jev.js";
import { DelegationGate, JevDelegationSelector, type DelegationDecision, type DelegationGateInput } from "./gate.js";
import { ModeController, policyForMode } from "./mode.js";
import { buildRepositoryProfile, describeFailureCost } from "./live-data.js";
import { quotaSelectorOptions } from "./selector-options.js";
import { resolveCostMode, readQuotaState, type QuotaState } from "./quota.js";
import { buildSetupPlan, detectWebAccessExtensions, discoverSetupCandidates, probeSetupPlan, setupConfig, writeSetupConfig } from "./onboarding.js";
import { readProbeCache, probeWorkingDir, writeProbeCache } from "./reachability.js";
import { appendReceipt, defaultDecisionReceiptPath } from "./receipt-store.js";
import { buildDecisionReceipt, sanitizeError } from "./receipts.js";
import { modelKey, type CandidateProfile, type DelegateConfig, type DelegateRequest, type JevChoiceInput, type JevChoiceAnswer, type ModelIdentity, type TrustedAgent } from "./types.js";

const TOOL_NAME = "delegate_task";

const AssignmentParams = Type.Object({
  agent: Type.String({ description: "Name of a configured trusted child agent" }),
  task: Type.String({ description: "One self-contained assignment for the child" }),
  expectedOutput: Type.Optional(Type.String({ description: "Optional acceptance or output description" })),
  context: Type.Optional(Type.String({ description: "Optional bounded context; not a permission grant" })),
});
const DelegateTaskParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of a configured trusted child agent (single form)" })),
  task: Type.Optional(Type.String({ description: "One self-contained assignment (single form)" })),
  expectedOutput: Type.Optional(Type.String({ description: "Optional acceptance or output description (single form)" })),
  context: Type.Optional(Type.String({ description: "Optional bounded context; not a permission grant (single form)" })),
  assignments: Type.Optional(Type.Array(AssignmentParams, { minItems: 1, description: "Batch of independent assignments" })),
}, { additionalProperties: false });
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

function eligibleCandidates(config: DelegateConfig, agent: TrustedAgent, ctx: ExtensionContext, quotaState?: QuotaState, health?: HealthStore): CandidateProfile[] {
  return resolveEligibleCandidates({
    config,
    agent,
    ctx,
    ...(quotaState ? { quotaState } : {}),
    ...(health ? { health } : {}),
  }).candidates;
}

function validateChildTools(agent: TrustedAgent): string[] {
  validateConfiguredChildTools(agent);
  return [...new Set(agent.tools)];
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
  quotaState?: QuotaState,
  health?: HealthStore,
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
  const candidates = eligibleCandidates(config, effectiveAgent, ctx, quotaState, health);
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
  health?: HealthStore,
): { candidates: CandidateProfile[]; childAvailable: boolean; agentNames: string[]; providerQuota?: QuotaState } {
  const agentNames: string[] = [];
  const providerQuota = readQuotaState();
  let anyLaunchable = false;
  for (const name of Object.keys(config.agents)) {
    if (launchableChild(config, name, ctx, jevChoose, providerQuota, health)) {
      agentNames.push(name);
      anyLaunchable = true;
    }
  }
  // The gate's candidate pool is agent-independent: use an agent whose tools
  // are structurally valid so only registry/auth/quota/reachability/health
  // filter the pool, exactly as dispatch would see it.
  const candidates = resolveEligibleCandidates({
    config,
    agent: { name: "gate", instructions: "", tools: [] },
    ctx,
    ...(providerQuota ? { quotaState: providerQuota } : {}),
    ...(health ? { health } : {}),
  }).candidates;
  return { candidates, childAvailable: anyLaunchable, agentNames, providerQuota };
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

function buildGateInput(config: DelegateConfig, mode: ModeController, ctx: ExtensionContext, prompt: string, jevChoose?: (input: JevChoiceInput) => Promise<JevChoiceAnswer>, health?: HealthStore): DelegationGateInput {
  const available = gateCandidates(config, ctx, jevChoose, health);
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
    ...(available.providerQuota && Object.keys(available.providerQuota).length > 0 ? { providerQuota: available.providerQuota } : {}),
    allowExternalSensing: config.allowExternalSensing,
    deadlineMs: config.limits.selectionDeadlineMs,
    maxGatePromptChars: config.limits.maxGatePromptChars,
    // Bounded, non-source repository profile so the same request can rate
    // differently in a small app than in a monorepo. Names and counts only —
    // never file contents, never conversation history.
    repository: buildRepositoryProfile(ctx.cwd, contextFileNames(ctx)),
    // Second half of `expected cost = token cost + P(failure) x cost of
    // failure`: say plainly what a wrong answer costs here.
    failureCost: describeFailureCost({
      ...(readOnlyWorkspace(mode) ? { readOnly: true } : {}),
    }),
  };
}

/** Whether the active mode forbids direct mutation, i.e. work is read-only here. */
function readOnlyWorkspace(mode: ModeController): boolean {
  return mode.current() !== "normal";
}

/**
 * Names of Pi-loaded context files (AGENTS.md / CLAUDE.md). Names only: the
 * profile exists to size the repository, not to ship its contents to a sensor.
 */
function contextFileNames(ctx: ExtensionContext): string[] {
  try {
    const prompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
    const found: string[] = [];
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      if (typeof prompt === "string" && prompt.includes(name)) found.push(name);
    }
    return found;
  } catch {
    return [];
  }
}

function statusText(config: DelegateConfig, mode: string): string {
  const candidates = config.candidates.map((candidate) => modelKey(candidate.identity)).join(", ") || "none";
  const agents = Object.keys(config.agents).join(", ") || "none";
  return `pi-delegateau: mode=${mode}, selection=${config.selection}, preference=${config.preference}, agents=${agents}, configured candidates=${candidates}, Jev disclosure=${config.allowExternalSensing ? "allowed" : "prohibited"}`;
}

// All dispatches in one extension instance share the in-memory store. This
// prevents concurrent parent tool calls from loading the same JSON snapshot and
// overwriting each other's failure event; the store still persists across Pi
// restarts. A changed project/config gets a separate store rather than mutating
// the policy of an in-flight dispatch.
const healthStores = new Map<string, HealthStore>();

function healthStoreFor(cwd: string, config: DelegateConfig): HealthStore {
  const key = JSON.stringify([cwd, config.health ?? null]);
  const existing = healthStores.get(key);
  if (existing) return existing;
  const store = new HealthStore({ cwd, config: config.health });
  healthStores.set(key, store);
  return store;
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
    description: "Delegate one assignment or a batch of independent assignments to configured trusted children. Dispatches use a bounded parallel pool and FIFO queue.",
    promptSnippet: "Delegate one or more self-contained assignments to trusted child agents",
    promptGuidelines: ["Use delegate_task for an assignment that should run on a separately selected child model; the parent owns acceptance."],
    parameters: DelegateTaskParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (typeof (ctx as any).isProjectTrusted === "function" && !(ctx as any).isProjectTrusted()) {
        throw new DelegationToolError({
          text: "Delegation is unavailable: this project is not trusted. Trust the project in Pi first.",
          details: { status: "launch-error", error: "project-not-trusted" },
        });
      }
      const config = loadConfig(ctx.cwd);
      admission.configure(config.limits.concurrency, config.limits.maxQueueDepth);
      // One shared store per project/config: batch siblings and concurrent
      // parent calls observe each other's half-open trials and failure events.
      const health = healthStoreFor(ctx.cwd, config);
      const hasBatch = params.assignments !== undefined;
      const hasSingle = params.agent !== undefined || params.task !== undefined || params.expectedOutput !== undefined || params.context !== undefined;
      if (hasBatch === hasSingle) {
        throw new DelegationToolError({
          text: "Use either the single agent/task form or assignments, not both",
          details: { status: "launch-error", error: "invalid-assignment-form" },
        });
      }
      const assignments: AssignmentInput[] = hasBatch
        ? params.assignments!
        : [{ agent: params.agent!, task: params.task!, ...(params.expectedOutput ? { expectedOutput: params.expectedOutput } : {}), ...(params.context ? { context: params.context } : {}) }];
      if (assignments.length === 0 || !admission.canAccept(assignments.length)) {
        throw new DelegationToolError({
          text: `Delegation batch of ${assignments.length} exceeds the available slots plus queue capacity`,
          details: { status: "queue-full", assignments: assignments.length },
        });
      }
      const prepared = assignments.map((assignment) => {
        if (!assignment.agent || typeof assignment.task !== "string") {
          throw new DelegationToolError({ text: "Every assignment requires agent and task", details: { status: "launch-error", error: "invalid-assignment" } });
        }
        validateAssignment(config, assignment);
        const agent = configuredAgent(config, assignment.agent);
        validateConfiguredChildTools(agent);
        return { assignment, agent };
      });
      if (signal?.aborted) throw new DelegationToolError({ text: "Delegation cancelled before launch", details: { status: "cancelled" } });

      const owningDecision = gate.current();
      const owningDecisionId = owningDecision?.decisionId;
      // The gate's difficulty judgement rides along with its decision id: the
      // chooser should not have to re-infer difficulty from raw task text when
      // the same request was just classified.
      const owningComplexity = owningDecision?.complexity;
      const settled = await Promise.allSettled(prepared.map(({ assignment, agent }) => executeDispatch({
        config,
        agent,
        assignment,
        ctx,
        pool: admission,
        ...(signal ? { signal } : {}),
        ...(onUpdate ? { onUpdate } : {}),
        ...(owningDecisionId ? { decisionId: owningDecisionId } : {}),
        ...(owningComplexity ? { complexity: owningComplexity } : {}),
        health,
        registerController: (controller) => activeDispatches.add(controller),
        unregisterController: (controller) => activeDispatches.delete(controller),
        markDelegated: () => gate.markExecution("delegated"),
      })));
      const results = settled.map((item) => item.status === "fulfilled"
        ? { ok: true as const, result: item.value }
        : { ok: false as const, error: item.reason instanceof DispatchFailure ? item.reason.payload : { text: sanitizeError(String(item.reason)), details: { status: "launch-error" } } });

      if (!hasBatch) {
        const only = results[0]!;
        if (!only.ok) throw new DelegationToolError(only.error);
        return only.result;
      }
      const details = {
        status: results.every((result) => result.ok) ? "success" : "partial-failure",
        dispatches: results.map((result) => result.ok ? result.result.details : result.error.details),
      };
      const text = results.map((result, index) => result.ok
        ? `Assignment ${index + 1}: ${String(result.result.details.status)} (${String(result.result.details.dispatchId)})`
        : `Assignment ${index + 1}: ${result.error.text}`).join("\n\n");
      if (!results.every((result) => result.ok)) throw new DelegationToolError({ text, details });
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerCommand("delegateau", {
    description: "Show/change status and mode, or explicitly review/write first-use setup",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const command = words[0] ?? "status";
      if (command === "setup") {
        // Explicit, side-effect-free review. It intentionally does not probe,
        // measure quotas, or fetch benchmarks: those are separate opt-in
        // commands and must never run at import, session start, or review.
        const probeCache = readProbeCache();
        const installedExtensions = detectWebAccessExtensions(pi.getAllTools());
        // Only exact identities in the current live authenticated registry can
        // carry evidence; cached records are revalidated against it every time.
        const knownModels = discoverSetupCandidates(ctx.modelRegistry as any).map((candidate) => candidate.identity);
        const evidence = revalidateBenchmarkCache(readBenchmarkCache(), { knownModels });
        const plan = buildSetupPlan(ctx.modelRegistry as any, {
          installedExtensions,
          evidence: evidence.records,
          ...(probeCache ? { probes: probeCache } : {}),
        });
        const generated = setupConfig(plan);
        const measured = plan.candidates.filter((candidate) => (candidate.benchmarks?.length ?? 0) > 0).length;
        const unmeasured = plan.candidates.length - measured;
        const ids = plan.candidates.map((candidate) => modelKey(candidate.identity)).join(", ") || "none";
        const ignored = evidence.diagnostics.length > 0 ? ` ${evidence.diagnostics.length} cached record diagnostic(s) ignored.` : "";
        const review = `setup review: ${plan.candidates.length} configured Pi models (${measured} measured, ${unmeasured} unmeasured): ${ids}.${ignored} ${plan.reasons.join("; ") || "No benchmark records were invented; unmeasured candidates stay reviewable."}`;
        const commandHelp = "Commands: /delegateau setup probe (reachability), /delegateau setup import <file> (no network), /delegateau setup retrieve artificial-analysis <mapping-file> (explicit network), /delegateau setup apply. Limits: 8 records/model, HTTPS-only sources, records older than 730 days ignored.";
        if (words[1] === "probe") {
          const cache = await probeSetupPlan(plan, { cwd: probeWorkingDir() });
          writeProbeCache(cache);
          ctx.ui.notify(`pi-delegateau setup probe complete: ${cache.results.filter((r) => r.reachable).length}/${cache.results.length} reachable. Review results before applying; no project config was written.`, "info");
          return;
        }
        if (words[1] === "import") {
          const target = words[2];
          if (!target) { ctx.ui.notify("Usage: /delegateau setup import <file>", "warning"); return; }
          try {
            const result = await importBenchmarkFile(target, { knownModels });
            const diag = result.diagnostics.length > 0 ? ` ${result.diagnostics.length} ignored record diagnostic(s).` : "";
            const dropped = result.dropped > 0 ? ` ${result.dropped} record(s) were evicted by the per-model cap and were NOT stored.` : "";
            ctx.ui.notify(`pi-delegateau setup import: ${result.imported} record(s) read, ${result.retained} stored for live identities.${dropped}${diag} Cache: ${benchmarkCachePath()}. No network request was made.`, "info");
          } catch (error) {
            ctx.ui.notify(`pi-delegateau setup import failed: ${sanitizeError(error instanceof Error ? error.message : String(error))}`, "warning");
          }
          return;
        }
        if (words[1] === "retrieve") {
          const source = words[2];
          const mappingFile = words[3];
          if (source !== ARTIFICIAL_ANALYSIS_SOURCE) {
            ctx.ui.notify(`pi-delegateau setup retrieve: unsupported source "${source ?? ""}". Supported adapters: ${ARTIFICIAL_ANALYSIS_SOURCE}.`, "warning");
            return;
          }
          if (!mappingFile) { ctx.ui.notify("Usage: /delegateau setup retrieve artificial-analysis <mapping-file>", "warning"); return; }
          let mapping: ReturnType<typeof parseSourceModelMap>;
          try {
            mapping = parseSourceModelMap(JSON.parse(fs.readFileSync(mappingFile, "utf8")));
          } catch (error) {
            ctx.ui.notify(`pi-delegateau setup retrieve: invalid mapping (${sanitizeError(error instanceof Error ? error.message : String(error))})`, "warning");
            return;
          }
          const credential = process.env[ARTIFICIAL_ANALYSIS_API_KEY_ENV];
          if (!credential) {
            // No credential means no request and no cache write: the source is
            // unavailable, and candidates stay visibly unmeasured.
            ctx.ui.notify(`pi-delegateau setup retrieve: ${ARTIFICIAL_ANALYSIS_API_KEY_ENV} is absent from the process environment; no request was made, nothing was measured, and no cache was written.`, "warning");
            return;
          }
          const report = await retrieveArtificialAnalysis({ mapping: mapping.mappings, knownModels, credential });
          if (report.records.length === 0) {
            // A failed or empty retrieval must not mutate the cache: no new
            // evidence exists and a stale snapshot must not be rewritten.
            const diag = report.diagnostics.length > 0 ? ` ${report.diagnostics.length} ignored record diagnostic(s).` : "";
            ctx.ui.notify(`pi-delegateau setup retrieve: no records normalized from ${ARTIFICIAL_ANALYSIS_SOURCE}; no cache was written.${diag}`, "warning");
            return;
          }
          const cache = mergeBenchmarkReport(readBenchmarkCache(), report, { knownModels });
          writeBenchmarkCache(cache);
          const keys = new Set(cache.records.map(benchmarkRecordKey));
          const stored = report.records.filter((entry) => keys.has(benchmarkRecordKey(entry))).length;
          const evicted = report.records.length - stored;
          const diag = report.diagnostics.length > 0 ? ` ${report.diagnostics.length} ignored record diagnostic(s).` : "";
          const evictText = evicted > 0 ? ` ${evicted} record(s) were evicted by the per-model cap and were NOT stored.` : "";
          ctx.ui.notify(`pi-delegateau setup retrieve: ${report.records.length} record(s) normalized from ${ARTIFICIAL_ANALYSIS_SOURCE}, ${stored} stored (attribution: https://artificialanalysis.ai/).${evictText}${diag} Cache: ${benchmarkCachePath()}.`, report.records.length > 0 ? "info" : "warning");
          return;
        }
        if (words[1] !== "apply") { ctx.ui.notify(`pi-delegateau ${review} ${commandHelp}`, "info"); return; }
        const configPath = path.join(ctx.cwd, CONFIG_FILE_NAME);
        const existing = fs.existsSync(configPath);
        const confirmed = typeof ctx.ui.confirm === "function"
          ? await ctx.ui.confirm("Review delegateau setup?", `${review}\nPrepare ${configPath}${existing ? " (an existing config is present)" : ""}.`)
          : false;
        const overwrite = existing && confirmed && typeof ctx.ui.confirm === "function"
          ? await ctx.ui.confirm("Overwrite existing delegateau config?", `Replace ${configPath}?`)
          : false;
        const written = writeSetupConfig(ctx.cwd, generated, confirmed, overwrite);
        ctx.ui.notify(written ? `pi-delegateau setup wrote ${written}` : "pi-delegateau setup not confirmed; no config was written.", written ? "info" : "warning");
        return;
      }
      const resolved = resolveConfig({ cwd: ctx.cwd });
      const config = resolved.config;
      mode.setAllowedTools("delegate-execution", config.allowedParentTools.delegateExecution);
      mode.setAllowedTools("coordinator-only", config.allowedParentTools.coordinatorOnly);
      admission.configure(config.limits.concurrency, config.limits.maxQueueDepth);
      if (command === "status") {
        const decision = gate.current();
        const decisionText = decision ? `, gate=${decision.status}/${decision.source}${decision.recommendation ? `:${decision.recommendation}` : ""}` : "";
        const pool = admission.status();
        const blockedReasons = pool.blockedReasons.length > 0 ? ` (${pool.blockedReasons.join("; ")})` : "";
        const busyText = `, slots=${pool.occupied}/${pool.concurrency} running=${pool.running} blocked=${pool.blocked}${blockedReasons}, queue=${pool.queued}/${pool.maxQueueDepth}`;
        const shadowText = shadowedDelegateTaskCalls ? ", tool-shadowing=suspected (delegate_task resolved outside this extension; check for a competing extension)" : "";
        const health = new HealthStore({ cwd: ctx.cwd, config: config.health });
        const openCircuits = health.openCircuits();
        // Open circuits and dead trial claims are reported separately: a circuit
        // hides itself from nothing, but a stranded claim is neither open nor
        // healthy and would otherwise leave a model silently unusable.
        const expiredTrials = openCircuits.filter((entry) => entry.trialExpired === true);
        const openOnly = openCircuits.filter((entry) => entry.trialExpired !== true);
        const healthText = `, health=${openOnly.length} open circuit${openOnly.length === 1 ? "" : "s"}${openOnly.length > 0 ? ` (${openOnly.slice(0, 3).map((entry) => `${entry.model}: ${entry.category ?? "unknown"} until ${entry.openUntil ?? "unknown"}`).join("; ")}${openOnly.length > 3 ? `; +${openOnly.length - 3} more` : ""})` : ""}${expiredTrials.length > 0 ? `, ${expiredTrials.length} stale trial claim${expiredTrials.length === 1 ? "" : "s"} cleared (${expiredTrials.slice(0, 3).map((entry) => entry.model).join("; ")})` : ""}`;
        const measuredCandidates = config.candidates.filter((candidate) => (candidate.benchmarks?.length ?? 0) > 0).length;
        // Records that aged out of the config are surfaced, not silently gone: the
        // only way a reader learns a candidate lost its evidence is being told.
        const droppedRecords = config.benchmarkDiagnostics ?? [];
        const droppedText = droppedRecords.length > 0
          ? `; ${droppedRecords.length} config record${droppedRecords.length === 1 ? "" : "s"} dropped as ${[...new Set(droppedRecords.map((entry) => entry.category))].join("/")} — refresh with /delegateau setup retrieve`
          : "";
        const benchmarkText = `, benchmarks=${measuredCandidates}/${config.candidates.length} candidates measured${droppedText}`;
        const sourceText = `, config=${resolved.source}${resolved.path ? ` (${resolved.path})` : ""}`;
        ctx.ui.notify(`${statusText(config, mode.current())}, delegation decision=${config.delegationDecision}${decisionText}${busyText}${healthText}${benchmarkText}${sourceText}${shadowText}`, "info");
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
        ? (input: JevChoiceInput) => new JevSelector(quotaSelectorOptions(config.limits.selectionDeadlineMs, config.costMode)).choose(input)
        : undefined;
      decision = await gate.ensure(buildGateInput(config, mode, ctx, event.prompt, jevChoose, new HealthStore({ cwd: ctx.cwd, config: config.health })), selector);
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
        ? (input: JevChoiceInput) => new JevSelector(quotaSelectorOptions(config.limits.selectionDeadlineMs, config.costMode)).choose(input)
        : undefined;
      const decision = await gate.ensure(buildGateInput(config, mode, ctx, event.text ?? "", jevChoose, new HealthStore({ cwd: ctx.cwd, config: config.health })), selector);
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
    admission.configure(config.limits.concurrency, config.limits.maxQueueDepth);
    mode.setAllowedTools("delegate-execution", config.allowedParentTools.delegateExecution);
    mode.setAllowedTools("coordinator-only", config.allowedParentTools.coordinatorOnly);
    // Report the REAL mode, not an unconditional "normal" claim (F22-adjacent).
    ctx.ui.setStatus("pi-delegateau", `${mode.current()} mode; /delegateau status; gate=${config.delegationDecision}`);

    // Report how each provider's cost is being metered, and say WHICH provider
    // credentials were found. This is the "check which providers you have and
    // whether it's a sub or credits" surface: a wrong inference here silently
    // mis-ranks every candidate, so the user must be able to see and correct it.
    try {
      const seen: string[] = [];
      for (const provider of new Set(config.candidates.map((c) => c.identity.provider))) {
        const resolution = resolveCostMode(provider, config.costMode ?? {});
        const modeText = resolution.mode === "quota-gpu-time" ? "quota (GPU time)" : "per-token";
        const authText = resolution.authType ? `${resolution.authType}` : "no credential found yet";
        seen.push(`${provider}: ${modeText} [${authText}, ${resolution.decidedBy}]`);
      }
      if (seen.length > 0) {
        ctx.ui.notify(`pi-delegateau cost metering — ${seen.join("; ")}. Correct with costMode in ${CONFIG_FILE_NAME} if wrong.`, "info");
      }
    } catch {
      // Reporting is best-effort; never let it break session start.
    }

    // Reachability probes are explicit via `/delegateau setup probe`; session
    // startup must not create provider traffic or spend quota.
  });
  pi.on("session_shutdown", () => {
    gate.invalidate("session shutdown");
    for (const controller of activeDispatches) controller.abort();
    mode.clearRequestRestriction();
    mode.setBusy(false);
  });
}

export { DelegateTaskParams, CHILD_TOOLS };