#!/usr/bin/env node
/**
 * Benchmark evidence: decide whether the routing evidence is still good, and refresh
 * it when it is not.
 *
 * WHY THIS RUNS ITSELF: a check nobody remembers to run is a chore, and evidence that
 * is silently two years old is worse than none. So the default action is "look, decide,
 * act" — call it as part of loading this project's skill and it keeps the evidence
 * current by itself. It only spends a network call when there is a reason to.
 *
 * WHAT IT LOOKS AT (no network needed for the decision):
 *   - how old the evidence in the effective config is (evidence older than 90 days is
 *     refreshed, because a score from last year quietly mis-ranks models);
 *   - whether any config record has already been dropped as expired;
 *   - whether Pi's model list changed since the last refresh (models added, removed or
 *     renamed) — the usual reason a model silently stops being scored;
 *   - whether the model list is even readable.
 *
 * WHAT IT DOES WHEN THERE IS A REASON:
 *   re-derives the who-is-who list from live sources, fetches current scores, and copies
 *   them into the config that is actually in effect. Backs the file up first, writes
 *   atomically, and re-opens the result with the extension's own parser to prove it still
 *   loads. Nothing else in the file is touched (no pool changes, no descriptions).
 *
 * SAFETY
 *   - Never prints the credential, and never sends it anywhere but the documented host.
 *   - Refuses to hammer: a failed or recent attempt is not retried until the cooldown passes.
 *   - A refresh that cannot run (no credential, no network) reports why and exits 0, so
 *     this is safe to call from anything that must not fail closed.
 *
 * USAGE
 *   node scripts/benchmark-evidence.mjs              # decide, and refresh if warranted
 *   node scripts/benchmark-evidence.mjs --check      # decide only, change nothing
 *   node scripts/benchmark-evidence.mjs --force      # refresh regardless of age
 *   node scripts/benchmark-evidence.mjs --json       # machine-readable result
 *   node scripts/benchmark-evidence.mjs --config X   # target a specific config file
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const CHECK_ONLY = flag("--check");
const FORCE = flag("--force");
const AS_JSON = flag("--json");
const CONFIG_OVERRIDE = value("--config");

/** Evidence older than this is refreshed: a year-old score quietly mis-ranks models. */
const STALE_AFTER_DAYS = Number(process.env.DELEGATEAU_EVIDENCE_MAX_AGE_DAYS ?? 90);
/** Do not re-attempt a refresh more often than this, however often this script is called. */
const RETRY_COOLDOWN_HOURS = Number(process.env.DELEGATEAU_REFRESH_COOLDOWN_HOURS ?? 6);

const PI_BIN = process.env.PI_BIN ?? "/home/nazar/.local/bin/pi";
const HERMES_ENV = path.join(os.homedir(), ".hermes", ".env");
const CREDENTIAL_ENV = "ARTIFICIAL_ANALYSIS_API_KEY";

const load = (rel) => import(path.join(repo, "dist/src", rel));
const days = (ms) => Math.floor(ms / 86_400_000);

/**
 * The credential, read from the environment or this machine's own env file. It is only
 * ever passed to a subprocess, never printed.
 */
function credential() {
  if (process.env[CREDENTIAL_ENV]) return process.env[CREDENTIAL_ENV];
  try {
    for (const line of fs.readFileSync(HERMES_ENV, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && match[1] === CREDENTIAL_ENV) return match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No env file is not an error; the caller reports the credential as absent.
  }
  return undefined;
}

/** The exact `provider/id` set this machine serves. Read from the REAL agent dir. */
function liveModels() {
  const env = { ...process.env };
  // A scratch agent dir carries no credentials and lists almost nothing.
  delete env.PI_CODING_AGENT_DIR;
  const out = execFileSync(PI_BIN, ["--list-models"], { encoding: "utf8", env, timeout: 120_000 });
  return out.split("\n").slice(1)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2 && !parts[0].includes("/"))
    .map((parts) => ({ provider: parts[0], id: parts[1] }));
}

const keyOf = (identity) => `${identity.provider}/${identity.id}`;

const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "delegateau", "evidence-refresh.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const { resolveConfig, parseConfig } = await load("config.js");
  const { readBenchmarkCache, revalidateBenchmarkCache, benchmarkCachePath, MAX_BENCHMARK_AGE_MS } = await load("benchmarks.js");
  const { mergeBenchmarkReport, writeBenchmarkCache } = await load("benchmarks.js");

  const resolved = resolveConfig({ cwd: process.cwd() });
  const configPath = CONFIG_OVERRIDE ?? resolved.path ?? path.join(os.homedir(), ".pi", "agent", "delegateau.json");
  const live = liveModels();
  const liveKeys = live.map(keyOf);
  const liveSet = new Set(liveKeys);
  const cache = readBenchmarkCache();
  const revalidated = revalidateBenchmarkCache(cache, { knownModels: live });
  const state = readState();

  // ---- What the effective config currently carries -------------------------------
  const carried = resolved.config.candidates.filter((c) => (c.benchmarks?.length ?? 0) > 0);
  const dates = carried.flatMap((c) => (c.benchmarks ?? []).map((r) => r.date)).filter(Boolean).sort();
  const oldest = dates[0];
  const ageDays = oldest ? days(Date.now() - Date.parse(`${oldest}T00:00:00Z`)) : undefined;
  const expiresOn = oldest ? new Date(Date.parse(`${oldest}T00:00:00Z`) + MAX_BENCHMARK_AGE_MS).toISOString().slice(0, 10) : undefined;
  const configDropped = (resolved.config.benchmarkDiagnostics ?? []).length;
  const unmatched = revalidated.diagnostics.filter((d) => d.category === "unmatched-model").length;
  const agedOutOfCache = revalidated.diagnostics.length - unmatched;

  // ---- Did Pi's model list change since the last refresh? ------------------------
  const previousList = Array.isArray(state.modelList) ? state.modelList : undefined;
  // On the FIRST run there is no recorded list, so nothing can have "changed" — without
  // this guard every first run (and every run after the state file is cleared) reports
  // the whole registry as added and removed.
  const added = previousList ? liveKeys.filter((m) => !previousList.includes(m)) : [];
  const removed = previousList ? previousList.filter((m) => !liveSet.has(m)) : [];
  const registryChanged = previousList !== undefined && (added.length > 0 || removed.length > 0);

  // ---- The decision ---------------------------------------------------------------
  const reasons = [];
  if (FORCE) reasons.push("forced");
  if (carried.length === 0) reasons.push("no evidence in the effective config");
  if (ageDays !== undefined && ageDays > STALE_AFTER_DAYS) reasons.push(`evidence is ${ageDays} days old`);
  if (configDropped > 0) reasons.push(`${configDropped} config record(s) expired`);
  if (agedOutOfCache > 0) reasons.push(`${agedOutOfCache} cached record(s) no longer validate`);
  if (registryChanged) reasons.push(`Pi's model list changed (${added.length} added, ${removed.length} removed)`);

  const due = reasons.length > 0;
  const lastAttempt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : undefined;
  const cooldownMs = RETRY_COOLDOWN_HOURS * 3_600_000;
  const recent = lastAttempt !== undefined && Date.now() - lastAttempt < cooldownMs;
  const willRefresh = due && !CHECK_ONLY && !recent;

  const report = {
    checkedAt: new Date().toISOString(),
    configSource: resolved.source,
    configPath,
    poolSize: resolved.config.candidates.length,
    candidatesWithEvidence: carried.length,
    recordsInConfig: dates.length,
    recordsInCache: cache?.records.length ?? 0,
    evidenceAgeDays: ageDays ?? null,
    maxAgeDays: STALE_AFTER_DAYS,
    oldestRecordExpiresOn: expiresOn ?? null,
    recordsAddedSinceRefresh: added.length,
    recordsRemovedSinceRefresh: removed.length,
    unmatchedModels: unmatched,
    refreshDue: due,
    reasons,
    refreshed: false,
    skippedBecause: !due
      ? "evidence is current"
      : recent
        ? `a refresh was attempted ${Math.round((Date.now() - lastAttempt) / 3_600_000)}h ago; cooling down`
        : CHECK_ONLY
          ? "check-only run"
          : undefined,
  };

  if (AS_JSON && (CHECK_ONLY || !willRefresh)) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (!willRefresh) {
    // Record the current model list as the baseline even when nothing needs doing.
    // Without this the FIRST change can never be detected: the list would only be stored
    // by a refresh, and fresh evidence means no refresh runs, so a newly added model would
    // go unnoticed until the evidence aged out.
    if (previousList === undefined && !CHECK_ONLY) writeState({ ...state, modelList: liveKeys });
    if (!AS_JSON) {
      console.log(`Benchmark evidence checked ${new Date().toISOString().slice(0, 10)} — ${resolved.source} config`);
      console.log(`  ${carried.length} of ${report.poolSize} candidates carry evidence; ${report.recordsInConfig} records, newest ${oldest ?? "none"}`);
      if (expiresOn) console.log(`  oldest record falls out on ${expiresOn} (then that model just shows as unmeasured)`);
      if (unmatched > 0) console.log(`  ${unmatched} record(s) no longer match a model Pi serves (renamed or removed)`);
      if (added.length || removed.length) console.log(`  Pi's model list changed: ${added.length} added, ${removed.length} removed`);
      console.log(`\n${due ? `No refresh: ${report.skippedBecause}` : "Evidence is current — nothing to do."}`);
      if (due && CHECK_ONLY) console.log(`  Reason: ${reasons.join("; ")}. Run without --check to refresh.`);
    }
    return 0;
  }

  // ---- Refresh ---------------------------------------------------------------------
  const key = credential();
  if (!key) {
    if (AS_JSON) console.log(JSON.stringify({ ...report, skippedBecause: `no ${CREDENTIAL_ENV}` }, null, 2));
    else console.log(`\nRefresh needed (${reasons.join("; ")}), but ${CREDENTIAL_ENV} was not found in the environment or ${HERMES_ENV}. Nothing was fetched.`);
    writeState({ ...state, lastAttemptAt: new Date().toISOString(), lastOutcome: "no-credential" });
    return 0;
  }

  const env = { ...process.env, [CREDENTIAL_ENV]: key };
  try {
    console.log(`Refreshing benchmark evidence: ${reasons.join("; ")}`);
    const mappingFile = path.join(repo, ".pi", "aa-mapping.json");
    fs.mkdirSync(path.dirname(mappingFile), { recursive: true });

    console.log("  deriving the who-is-who list from live sources...");
    const derived = execFileSync("python3", [path.join(repo, "scripts", "build-aa-mapping.py"), mappingFile], { encoding: "utf8", env });
    const mapped = /mapped: (\d+)/.exec(derived)?.[1];
    const omitted = /unmatched: (\d+)/.exec(derived)?.[1];
    console.log(`  matched ${mapped} models, ${omitted} with no exact counterpart (these stay unscored)`);

    const { retrieveArtificialAnalysis, parseSourceModelMap } = await load("benchmark-retrieval.js");
    const { mappings } = parseSourceModelMap(JSON.parse(fs.readFileSync(mappingFile, "utf8")));
    const knownModels = live;
    const fetched = await retrieveArtificialAnalysis({ mapping: mappings, knownModels, credential: key });
    if (fetched.records.length === 0) throw new Error("the source returned no usable records; nothing changed");
    writeBenchmarkCache(mergeBenchmarkReport(readBenchmarkCache(), fetched, { knownModels }));

    // Copy only the scores onto the candidates that already exist. Nothing else changes.
    const { records } = revalidateBenchmarkCache(readBenchmarkCache(), { knownModels });
    const byModel = new Map();
    for (const record of records) {
      const id = `${record.model.provider}/${record.model.id}`;
      if (!byModel.has(id)) byModel.set(id, []);
      byModel.get(id).push(record);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!Array.isArray(raw.candidates)) throw new Error(`${configPath} has no candidates array`);
    let added = 0;
    let compacted = 0;
    for (const candidate of raw.candidates) {
      const found = byModel.get(`${candidate.provider}/${candidate.id}`);
      const existing = Array.isArray(candidate.benchmarks) ? candidate.benchmarks : [];
      if (!found && existing.length === 0) continue;
      // One record per (metric, version, score), keeping the most recent date. The
      // adapter dates each fetch with the retrieval date, so a plain append would file the
      // same measurement once per refresh until the per-model cap evicted real evidence;
      // this also compacts any duplicates an earlier run left behind. A genuinely changed
      // score, version or metric is a different key and is kept as its own record.
      const byMeasurement = new Map();
      const order = [];
      for (const record of [...existing, ...found]) {
        const key = [record.metric, record.version, record.score].join("\u001f");
        const previous = byMeasurement.get(key);
        if (previous) {
          if (record.date > previous.date) byMeasurement.set(key, record);
          continue;
        }
        byMeasurement.set(key, record);
        order.push(key);
      }
      const before = order.length;
      candidate.benchmarks = order.map((key) => byMeasurement.get(key)).slice(-8);
      added += Math.max(0, candidate.benchmarks.length - existing.length);
      compacted += Math.max(0, existing.length + (found?.length ?? 0) - before);
    }
    fs.copyFileSync(configPath, `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, configPath);

    // Prove the extension can still read it, using its own parser.
    const parsed = parseConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
    const measured = parsed.candidates.filter((c) => (c.benchmarks?.length ?? 0) > 0);
    report.refreshed = true;
    report.recordsAdded = added;
    report.duplicatesCompacted = compacted;
    report.candidatesWithEvidence = measured.length;
    const compactText = compacted > 0 ? `, ${compacted} duplicate(s) compacted` : "";
    console.log(`  attached ${added} new record(s)${compactText}; ${measured.length} of ${parsed.candidates.length} candidates now carry evidence`);
    console.log(`  config verified readable; backup alongside it`);

    writeState({ lastAttemptAt: new Date().toISOString(), lastOutcome: "refreshed", modelList: liveKeys });
    if (AS_JSON) console.log(JSON.stringify(report, null, 2));
    else console.log("\nReady — routing evidence is current.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeState({ ...state, lastAttemptAt: new Date().toISOString(), lastOutcome: `failed: ${message.slice(0, 120)}` });
    if (AS_JSON) console.log(JSON.stringify({ ...report, error: message }, null, 2));
    else console.log(`\nRefresh failed and nothing changed: ${message}`);
    return 0;
  }
}

process.exit(await main());
