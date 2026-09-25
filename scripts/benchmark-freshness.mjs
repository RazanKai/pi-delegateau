#!/usr/bin/env node
/**
 * Benchmark-evidence freshness report for pi-delegateau.
 *
 * WHY THIS EXISTS: nothing refreshes benchmark evidence on its own. Retrieval is an
 * explicit command, so evidence ages silently until someone notices. This reports
 * what a human needs to decide whether to refresh — in plain terms, read-only, with
 * no network request and no write. `--refresh` additionally re-derives the mapping
 * and re-retrieves; it needs ARTIFICIAL_ANALYSIS_API_KEY and is never implicit.
 *
 * Run:
 *   node scripts/benchmark-freshness.mjs                 # read-only report
 *   node scripts/benchmark-freshness.mjs --refresh       # fetch + reinstall
 *   node scripts/benchmark-freshness.mjs --json          # machine-readable
 *
 * Exit code is 0 for a report and 0 for a completed refresh; a refresh that could
 * not run (no credential, network failure) also exits 0 after saying so, so this is
 * safe to call from a check that must not fail closed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const doRefresh = args.includes("--refresh");

/** Evidence older than this is called out even though it still loads. */
const STALE_AFTER_DAYS = 90;
const PI_BIN = process.env.PI_BIN ?? "/home/nazar/.local/bin/pi";
const MAPPING = process.env.DELEGATEAU_AA_MAPPING ?? path.join(process.env.HOME ?? "", ".local/share/pi-delegateau-setup/aa-mapping.json");

const load = async (rel) => import(path.join(repo, "dist/src", rel));

const days = (ms) => Math.floor(ms / 86_400_000);
const today = () => new Date().toISOString().slice(0, 10);

function liveModels() {
  const env = { ...process.env };
  // A scratch agent dir carries no credentials and lists almost nothing; the model
  // LIST must come from the real agent dir.
  delete env.PI_CODING_AGENT_DIR;
  const out = execFileSync(PI_BIN, ["--list-models"], { encoding: "utf8", env });
  return out.split("\n").slice(1).map((line) => line.split(/\s+/)).filter((p) => p.length >= 2).map((p) => ({ provider: p[0], id: p[1] }));
}

async function main() {
  const { resolveConfig } = await load("config.js");
  const { readBenchmarkCache, revalidateBenchmarkCache, benchmarkCachePath, MAX_BENCHMARK_AGE_MS } = await load("benchmarks.js");

  const resolved = resolveConfig({ cwd: process.cwd() });
  const live = liveModels();
  const cache = readBenchmarkCache();
  const revalidated = revalidateBenchmarkCache(cache, { knownModels: live });

  const carried = resolved.config.candidates.filter((c) => (c.benchmarks?.length ?? 0) > 0);
  const withEvidence = new Map(carried.map((c) => [`${c.identity.provider}/${c.identity.id}`, c.benchmarks]));
  const allDates = [...withEvidence.values()].flat().map((r) => r.date).filter(Boolean).sort();
  const newest = allDates.at(-1);
  const oldest = allDates[0];
  const ageDays = newest ? days(Date.now() - Date.parse(`${newest}T00:00:00Z`)) : undefined;
  const expiresOn = oldest ? new Date(Date.parse(`${oldest}T00:00:00Z`) + MAX_BENCHMARK_AGE_MS).toISOString().slice(0, 10) : undefined;

  const configDropped = (resolved.config.benchmarkDiagnostics ?? []).length;
  const cacheDropped = revalidated.diagnostics.length;
  const unmatchedModels = revalidated.diagnostics.filter((d) => d.category === "unmatched-model").length;
  // Refresh is due when evidence has AGE out, been dropped, or is old enough to be
  // misleading — NOT when part of the pool is unmeasured. A model with no exact
  // catalog match can never be measured by refreshing, so counting it as "due"
  // would demand a fetch that cannot change anything.
  const due = (ageDays !== undefined && ageDays > STALE_AFTER_DAYS)
    || configDropped > 0
    || cacheDropped > unmatchedModels;

  const keyPresent = Boolean(process.env.ARTIFICIAL_ANALYSIS_API_KEY);
  const mappingPresent = fs.existsSync(MAPPING);

  const report = {
    checkedAt: new Date().toISOString(),
    configSource: resolved.source,
    configPath: resolved.path ?? "(defaults)",
    poolSize: resolved.config.candidates.length,
    candidatesWithEvidence: carried.length,
    recordsInConfig: allDates.length,
    recordsInCache: cache?.records.length ?? 0,
    newestRecord: newest ?? null,
    oldestRecord: oldest ?? null,
    evidenceAgeDays: ageDays ?? null,
    oldestRecordExpiresOn: expiresOn ?? null,
    configRecordsDropped: configDropped,
    cacheRecordsDropped: cacheDropped,
    unmatchedModels,
    refreshDue: due,
    credentialPresent: keyPresent,
    mappingFile: mappingPresent ? MAPPING : null,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Checked ${today()} — config: ${resolved.source}${resolved.path ? ` (${resolved.path})` : ""}`);
    console.log(`  pool: ${report.poolSize} candidates, ${report.candidatesWithEvidence} carrying benchmark evidence`);
    console.log(`  records: ${report.recordsInConfig} in config, ${report.recordsInCache} in cache`);
    if (newest) console.log(`  newest evidence: ${newest} (${ageDays} day${ageDays === 1 ? "" : "s"} old); oldest: ${oldest}`);
    if (expiresOn) console.log(`  oldest record drops out of the config on ${expiresOn} (730-day rule; the candidate then shows as unmeasured, nothing breaks)`);
    if (configDropped) console.log(`  ${configDropped} config record(s) were already dropped as stale/future-dated — those candidates are unmeasured now`);
    if (cacheDropped) console.log(`  ${cacheDropped} cached record(s) no longer validate against the live registry (${unmatchedModels} for a renamed/removed model, ${cacheDropped - unmatchedModels} for age)`);
    if (!due && carried.length < report.poolSize) {
      console.log(`  ${report.poolSize - carried.length} candidate(s) are unmeasured because nothing in the catalog matches them by exact id; refreshing cannot change that.`);
    }
    console.log(`  credential present: ${keyPresent ? "yes" : "no"}${mappingPresent ? "" : "; mapping file missing"}`);
    console.log(`\n${due ? "REFRESH RECOMMENDED" : "Fresh enough — no refresh needed"}`);
    if (due && !doRefresh) console.log("  Run with --refresh to re-derive the mapping and re-retrieve (needs ARTIFICIAL_ANALYSIS_API_KEY).");
  }

  if (!doRefresh) return 0;
  if (!keyPresent) {
    console.log("\nRefresh skipped: ARTIFICIAL_ANALYSIS_API_KEY is not in the environment; nothing was fetched.");
    return 0;
  }
  const mappingOut = MAPPING;
  try {
    console.log("\nRe-deriving the mapping from live sources...");
    execFileSync("python3", [path.join(repo, "scripts/build-aa-mapping.py"), mappingOut], { stdio: "inherit", env: process.env });
    const installer = path.join(process.env.HOME ?? "", ".local/share/pi-delegateau-setup/install-aa-evidence.mjs");
    if (!fs.existsSync(installer)) {
      console.log(`Retrieved, but no installer at ${installer}; the cache was updated and the config was NOT.`);
      return 0;
    }
    console.log("Re-retrieving and installing into the effective config...");
    execFileSync("node", [installer], { stdio: "inherit", env: process.env });
  } catch (error) {
    console.log(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

process.exit(await main());
