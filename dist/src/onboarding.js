import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCostMode } from "./quota.js";
import { runProbe } from "./reachability.js";
const WEB_ACCESS_EXTENSIONS = ["pi-web-access", "donsetch"];
export function detectWebAccessExtensions(tools) {
    return WEB_ACCESS_EXTENSIONS.filter((extension) => tools.some((tool) => {
        if (typeof tool !== "object" || tool === null)
            return false;
        const sourceInfo = tool.sourceInfo;
        return [sourceInfo?.path, sourceInfo?.source, sourceInfo?.baseDir].some((value) => typeof value === "string" && value.toLowerCase().includes(extension));
    }));
}
const roles = {
    scout: { tools: ["read", "grep", "find", "ls"], instructions: "Fast local codebase reconnaissance. Read-only: inspect files, locate relevant code, and report concise findings with paths. Do not modify files or run commands." },
    researcher: { tools: ["read", "grep", "find", "ls", "web_search", "web_fetch"], webAccess: true, instructions: "Research web and documentation sources. Return a concise brief with URLs, dates where relevant, and clear uncertainty. Do not modify files." },
    "evidence-auditor": { tools: ["read", "grep", "find", "ls", "web_search", "web_fetch"], webAccess: true, instructions: "Independently check research claims against primary sources. Report supported, contradicted, and unverified claims with source URLs. Do not modify files." },
    worker: { tools: ["read", "grep", "find", "ls", "bash", "edit", "write"], instructions: "Implement carefully, validate with focused checks, and report changes and results. Escalate ambiguity or missing evidence instead of guessing." },
    reviewer: { tools: ["read", "grep", "find", "ls", "edit", "write"], instructions: "Review task, plan, tests, edge cases, and simplicity. Small directly justified fixes are allowed; report them and any remaining concerns." },
    oracle: { tools: ["read", "grep", "find", "ls"], instructions: "Give a read-only second opinion. Challenge assumptions, identify missing evidence and simpler alternatives. Do not modify files." },
};
function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function key(i) { return `${i.provider}/${i.id}`; }
/** Discover only models Pi currently exposes AND says have configured auth. */
export function discoverSetupCandidates(registry, costMode = {}) {
    const seen = new Set();
    return registry.getAvailable().flatMap((model) => {
        if (!model.provider || !model.id || !registry.hasConfiguredAuth(model) || seen.has(key(model)))
            return [];
        seen.add(key(model));
        const cost = model.cost && [model.cost.input, model.cost.output, model.cost.cacheRead].some((v) => finite(v) !== undefined)
            ? { ...(finite(model.cost.input) !== undefined ? { input: model.cost.input } : {}), ...(finite(model.cost.output) !== undefined ? { output: model.cost.output } : {}), ...(finite(model.cost.cacheRead) !== undefined ? { cacheRead: model.cost.cacheRead } : {}) } : undefined;
        const access = resolveCostMode(model.provider, costMode);
        return [{ identity: { provider: model.provider, id: model.id }, description: "Discovered from Pi live registry; capabilities not independently benchmarked.", capabilities: [], provenance: "built-in", costSource: "provider", ...(cost ? { cost } : {}), ...(finite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}), ...(finite(model.maxTokens) ? { maxOutputTokens: model.maxTokens } : {}), ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}), ...(model.input?.length ? { inputModalities: [...model.input] } : {}), ...(finite(model.latencyMs) ? { latencyMs: model.latencyMs } : {}), accessMode: access.mode, accessDecision: access.decidedBy, state: "unmeasured" }];
    });
}
/** Only comparable evidence (same source, benchmark and version) can prove dominance. */
export function pruneSetupCandidates(candidates, evidence = [], probes) {
    const reasons = [];
    const withEvidence = candidates.map((candidate) => {
        const probe = probes?.results.find((r) => key(r.identity) === key(candidate.identity));
        const benchmark = evidence.find((e) => key(e.model) === key(candidate.identity));
        return { ...candidate, ...(probe ? { probe } : {}), ...(benchmark ? { benchmark } : {}) };
    });
    const live = withEvidence.filter((candidate) => {
        if (candidate.probe && !candidate.probe.reachable) {
            reasons.push(`${key(candidate.identity)} removed: confirmed unreachable (${candidate.probe.errorCategory ?? "unknown-error"})`);
            return false;
        }
        return true;
    }).map((candidate) => ({ ...candidate, state: candidate.probe?.reachable ? "reachable" : "unmeasured" }));
    const retained = live.filter((candidate) => {
        const mine = candidate.benchmark;
        if (!mine || mine.score === undefined)
            return true;
        const dominator = live.find((other) => {
            const theirs = other.benchmark;
            if (!theirs || theirs.score === undefined || other === candidate)
                return false;
            // Scores have meaning only within an identical source/benchmark/version.
            if (theirs.source !== mine.source || theirs.benchmark !== mine.benchmark || theirs.version !== mine.version)
                return false;
            const cheap = other.cost?.input !== undefined && candidate.cost?.input !== undefined && other.cost.input <= candidate.cost.input;
            const context = other.contextWindow !== undefined && candidate.contextWindow !== undefined && other.contextWindow >= candidate.contextWindow;
            const mineScore = mine.score;
            const theirScore = theirs.score;
            const otherInput = other.cost.input;
            const candidateInput = candidate.cost.input;
            const otherContext = other.contextWindow;
            const candidateContext = candidate.contextWindow;
            return theirScore >= mineScore && cheap && context && (theirScore > mineScore || otherInput < candidateInput || otherContext > candidateContext);
        });
        if (dominator) {
            reasons.push(`${key(candidate.identity)} removed: dominated by ${key(dominator.identity)} using ${mine.source}/${mine.benchmark}@${mine.version}`);
            return false;
        }
        return true;
    });
    return { candidates: retained, reasons };
}
export function roleTemplates(installedExtensions = []) {
    const unavailable = [];
    const agents = {};
    const webExtension = WEB_ACCESS_EXTENSIONS.find((extension) => installedExtensions.includes(extension));
    for (const [name, role] of Object.entries(roles)) {
        const childExtensions = role.webAccess ? (webExtension ? [webExtension] : undefined) : role.childExtensions;
        if (role.webAccess && !webExtension) {
            unavailable.push(`${name}: requires one of ${WEB_ACCESS_EXTENSIONS.join(" or ")}`);
            continue;
        }
        const { webAccess: _webAccess, ...template } = role;
        agents[name] = { ...template, ...(childExtensions ? { childExtensions } : {}) };
    }
    return { agents, unavailable };
}
export function buildSetupPlan(registry, options = {}) {
    const pruned = pruneSetupCandidates(discoverSetupCandidates(registry, options.costMode), options.evidence, options.probes);
    const templates = roleTemplates(options.installedExtensions);
    return { candidates: pruned.candidates, agents: templates.agents, reasons: [...pruned.reasons, ...templates.unavailable.map((x) => `${x}; agent unavailable until installed`)] };
}
/** Explicit opt-in only. Callers must set optIn; no import/session path calls this. */
export async function measureQuotaCost(optIn, measure) { return optIn ? measure() : undefined; }
export async function probeSetupPlan(plan, options) {
    return runProbe({ cwd: options.cwd, ...(options.command ? { command: options.command } : {}), targets: plan.candidates.map((c) => c.identity) });
}
/** Safe config projection: no credential/auth/cache/telemetry fields are representable. */
export function setupConfig(plan) {
    const candidates = plan.candidates.map(({ identity, description, capabilities, provenance, cost, costSource, contextWindow, maxOutputTokens, reasoning, inputModalities, latencyMs }) => ({ identity, description, capabilities, provenance, ...(cost ? { cost } : {}), ...(costSource ? { costSource } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(reasoning !== undefined ? { reasoning } : {}), ...(inputModalities ? { inputModalities } : {}), ...(latencyMs ? { latencyMs } : {}) }));
    return { selection: "jev", delegationDecision: "manual", preference: "balanced", candidates, ...(candidates[0] ? { defaultModel: candidates[0].identity } : {}), agents: plan.agents };
}
/** Writes only after caller's explicit affirmative confirmation. Existing files require overwrite too. */
export function writeSetupConfig(cwd, config, confirmed, overwrite = false) {
    const destination = path.join(cwd, ".pi", "delegateau.json");
    if (!confirmed || (fs.existsSync(destination) && !overwrite))
        return undefined;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return destination;
}
