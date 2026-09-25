# pi-delegateau work log

## 2026-09-25 19:17 CEST — review-fix round, derived AA mapping, live credentialed retrieval

- Independent final review of the uncommitted tree (delegated, own context) returned
  seven blocking defects plus acceptance gaps. All seven are fixed here, each with a
  regression that fails on the pre-fix tree and passes after:
  1. **Stranded trial claim.** `trialActive` was independent of `openUntil`, so a Pi
     killed mid-trial left `{openUntil, trialActive:true}` that `openCircuits` never
     reported while every dispatch answered `trial-in-progress`. `HealthRecord` now
     carries `trialClaimedAt`, `TRIAL_MAX_AGE_MS` bounds a claim, `isTrialClaimLive`
     gates the failure-count multiplier, `openCircuits()` surfaces and clears dead
     claims, and `tryClaimTrial` re-allows them.
  2. **Empty child error opened the circuit.** A non-zero exit after a completed answer
     arrives with `error` omitted; that was classified `provider-stream` (a counting
     category) and opened the circuit at `failureThreshold:1`. An absent/empty message
     is now `unknown` and does not count.
  3. **Acquisition could emit records its own parser rejects.** The response version
     label and score went through unchecked. `MAX_BENCHMARK_ABS_SCORE` and the version
     bound are now shared by the parser and the adapter; acquisition normalizes or
     reports, so a successful retrieval can never vanish on the next read.
  4. **Fresh import crowded out by the per-model cap.** `mergeRecords` filled with
     prior cache entries first and reported the import as imported. Ordering is now
     newest-first, evictions are reported, and the commands report **retained** counts.
  5. **Route trace capped silently.** `MAX_TRACE_BENCHMARKS` 64 raised to 512, and the
     trace now carries `offeredCount` + `truncated` so a partial list is never read as
     the whole one.
  6. **Credential could follow a redirect.** The `x-api-key` request now refuses
     redirects and is host-allow-listed to `artificialanalysis.ai`.
  7. **Config-embedded records skipped the age rule.** `parseConfig(raw, now)` threads
     the clock into `parseConfiguredBenchmarks`, so hand-written records obey the same
     730-day rule as imported and retrieved ones.
- **Mapping is derived, not hand-typed.** `scripts/build-aa-mapping.py` reads the live
  `pi --list-models` registry and the live AA Free-tier catalog and emits a pair only
  when exactly one AA entry matches a live Pi model after documented canonicalization
  (case/punctuation stripped). Live result: 19 of 25 Pi identities mapped; the other 6
  stay visibly unmeasured rather than being aliased. This is the file
  `/delegateau setup retrieve artificial-analysis <mapping>` consumes.
- **Credentialed retrieval ran live** (key from `ARTIFICIAL_ANALYSIS_API_KEY` in the
  environment; never read into a prompt, log, or file): 51 bounded records across the
  19 mapped identities, 100 bounded diagnostics, stored cache re-validated on read with
  zero loss. A real `JevSelector.choose` call then received per-candidate benchmark
  facts for 8 candidates, and the records reach the effective config
  (`~/.pi/agent/delegateau.json`, backed up before the write). T22 is promoted to DONE.
- Canonical `env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check`: **27 files /
  240 tests passed** (was 228). Red-on-base proof: with only the production changes
  reverted in a scratch copy, the 15 fix-relevant tests fail.
- Operational notes: the AA key was pasted into chat and should be rotated now that the
  retrieval has run. The key stays in `~/.hermes/.env` and the derived mapping file is
  `0600`; nothing credential-bearing is committed.

## 2026-09-19 03:49 CEST — M0/M1/M2/M3 implementation start

- Read `SPEC.md`, `DEVPLAN.md`, and the empty `WORKLOG.md` before coding.
- Verified the upstream integration baseline from live sources:
  - Pi package: `@earendil-works/pi-coding-agent` `0.85.1`.
  - TypeSafe JavaScript SDK: `@typesafe-ai/sdk` `0.6.0`.
  - Pi extension contracts used: `registerTool`, `registerCommand`, `tool_call`, `getActiveTools`, `setActiveTools`, `getAllTools`, `ctx.modelRegistry.find`, and `ctx.modelRegistry.hasConfiguredAuth`.
  - TypeSafe Choice contract used: `TypeSafeClient.systemOne({ state, model: "jev-latest", questions: { ...choice(...) } }, { signal, timeout, retry })`.
- Read the pinned pi-foreman license and source revision `e19a9ad9dce5c304e451e095e5899ddab00b3027`. Kept the exact MIT notice in `THIRD_PARTY_LICENSES/pi-foreman-MIT.txt`; documented adapted ideas in `NOTICE.md`. No pi-foreman runtime dependency was added.
- Created the standalone npm package, bounded dependencies, TypeScript build, Vitest runner, configuration parser, trusted-agent definitions, exact model identities, Pi registry/auth eligibility filtering, precedence-aware selection, Jev adapter, admission lock, explicit parent modes, child process runner, observed-exit cleanup, bounded results, cancellation/limits, receipts, and Pi entry point.
- Added tests for configuration, selection precedence/fallback/cancellation, Jev request shape, admission, mode restoration and call-time guards, child provider-error normalization, receipt redaction, and the actual extension registration/hooks.

### Commands and observed results

- `npm install` — succeeded; 214 packages added, 0 vulnerabilities.
- First `npm test` — intentionally red before implementation: all six source modules were missing.
- `npm run check` — passed: TypeScript build succeeded; 9 test files / 24 tests passed.
- `PI_OFFLINE=1 ./node_modules/.bin/pi -e ./src/index.ts --list-models` — exited 0 and printed Pi's normal no-models message; the extension loaded without pi-foreman.
- `npm pack /home/nazar/src/pi-delegateau --pack-destination /tmp/pi-delegateau-pack` followed by a clean `/tmp/pi-delegateau-consumer` install — succeeded; the packed tarball installed and exposed `pi.extensions` plus the Pi peer ranges. No production Pi installation was performed.

### Remaining evidence

No credentialed live Jev request, live child provider dispatch, non-git delegated task, descendant-cleanup probe, or fixed-versus-Jev pilot was run. Those remain TODO/PARTIAL in `DEVPLAN.md`; no mock result is being presented as live evidence.

## 2026-09-19 04:19 CEST — hardening and process-path verification

- Made Jev deadlines a real race: a chooser that ignores abort cannot keep the dispatch waiting past the selection deadline; cancellation still takes precedence over fallback.
- Kept trusted child instructions in the appended system prompt and moved task/context/expected output into the child user prompt as untrusted assignment data.
- Added abort-listener cleanup in the process spawner and a real temporary executable-child test covering explicit JSON launch flags, provider/model evidence, and observed wall-time cleanup.
- Final recorded status remains PARTIAL/TODO where a live provider, credentialed Jev call, or production Pi install is required.

## 2026-09-19 — delegation-decision gate added to the plan

- Added an optional local-versus-delegated Jev decision to `SPEC.md` and
  `DEVPLAN.md` without changing current implementation behavior.
- Defined `manual` (current default), `jev-suggest` (visible recommendation with
  parent override), and `jev-enforce` (tool-surface control with fail-closed
  behavior for execution tasks).
- Kept this decision separate from child-model selection. Jev cannot create
  subtasks, grant permissions, choose tools, or select the child model through
  this gate.
- Added T13 acceptance coverage for the real Pi pre-turn path, overrides,
  service failure, invalid decisions, cancellation, and late responses.

## 2026-09-19 13:22 CEST — gate implementation and final local verification

- Implemented the request-scoped delegation gate in `src/gate.ts` and wired it
  through `src/index.ts`'s `before_agent_start`, `tool_call`, `input`,
  `agent_settled`, session, and override paths.
- Added `manual`, `jev-suggest`, and `jev-enforce` configuration, bounded Jev
  decisions, generation tracking, steering cancellation, late-answer isolation,
  permission-preserving overrides, and independent decision receipts linked to
  dispatch receipts by `decisionId`.
- Hardened child execution with usage aggregation, provider-error normalization,
  process-start tracking, configurable `piCommand`, and descendant process-group
  cleanup. Added the real extension-entry fixture and descendant cleanup test.
- Added/updated tests for gate behavior, receipt linkage, advisory versus enforced
  restrictions, override races, live JSON child launch, non-git entry-path dispatch,
  and descendant termination.

### Commands and observed results

- `npm run check` — passed at 2026-09-19 13:21 CEST: TypeScript build succeeded;
  **11 test files / 38 tests passed**.
- `npm test -- --run tests/pi-process.test.ts` — passed: **3 tests**, including
  real descendant process-group termination.
- Credentialed `JevDelegationSelector` smoke call — returned a valid live
  recommendation with usage metadata. No provider-backed child could be run:
  local Pi reported `No models available` and the user explicitly deferred global
  Pi installation.

### Current evidence boundary

The implementation is complete locally, but T01–T11 and T13–T17 remain PARTIAL
where the acceptance contract requires real configured Pi/provider or live parent
entry-path evidence. T12 remains TODO because no fixed-versus-Jev quality/latency
pilot was run. These gaps are recorded in the authoritative coverage table; no
mock or fake-child result is presented as live provider evidence.

## 2026-09-19 17:xx CEST — review-fix campaign (F01–F13)

An independent review (`/home/nazar/src/pi-delegateau-review-2026-09-19/REVIEW.md`)
reproduced 13 defects. All were fixed in this pass:

- **F01 fail-open enforcement**: `JevDelegationSelector`/`JevSelector` now
  construct their TypeSafe client defensively (constructor never throws; a
  missing key surfaces as a normal `choose()` failure inside the gate's
  fail-closed/fallback logic), sensors are constructed lazily only for
  policies that sense, and the `before_agent_start` config read itself is
  guarded — every failure mode still installs an enforced restriction.
- **F02 orphaned cancellation rejection**: the gate's cancellation promise is
  created lazily only when sensing starts; manual/policy-determined fast paths
  leave no rejectable promise behind. Steering, `/new`, and shutdown no longer
  risk killing the host.
- **F03 project trust**: `delegate_task` refuses to run when
  `ctx.isProjectTrusted()` reports the project untrusted, before any config
  read or `piCommand` spawn.
- **F04 descendant leaks**: direct-child exit no longer cancels process-group
  escalation; the group is swept after the child closes (SIGTERM → SIGKILL →
  verified empty via /proc PGID scan), on normal exit, timeout, and
  cancellation. `SpawnResult.groupCleaned` feeds admission: an unverified
  group keeps the dispatch blocked.
- **F05 steering regeneration**: steering invalidates the decision, applies
  the enforced block, and immediately regenerates a decision for the steered
  prompt; settlement always clears the restriction (config-read failure
  cannot strand it).
- **F06 mode restoration**: clearing a request restriction under an active
  enforced mode re-applies the allowlist; mode activation saves the true
  normal surface. Default allowlists now use only real Pi 0.85.1 built-ins
  (`read`, `grep`, `find`, `ls`); `search`/`ask_user` removed.
- **F07 allowlist widening**: configured parent allowlists may remove tools
  but can never re-admit `bash`/`powershell`/`edit`/`write`; `delegate_task`
  is always kept.
- **F08 receipt privacy**: gate/chooser failure reasons are stored as stable
  categories (`credential-missing`, `timeout`, `invalid-response`,
  `cancelled`, `sensing-prohibited`, `sensor-error`), never raw remote text.
- **F09 availability/precedence**: the gate resolves child availability
  through the same pin/fixed/single-candidate/jev precedence dispatch uses
  (ineligible pins make a child unavailable), and hard base-mode policy is
  resolved BEFORE the disclosure check, so enforced modes work offline.
- **F10 chooser metadata**: provenance, cost, latency, and context window are
  forwarded to Jev so routing preferences are interpretable.
- **F11 bounds**: gate prompt truncation enforced inside the gate;
  `expectedOutput` validated; output truncation flagged (`outputTruncated`)
  and disclosed in the tool text; turn budget trips before consuming the
  over-budget turn; diagnostics bounded.
- **F12 error channel**: child failures throw (Pi marks fulfilled executes as
  non-errors regardless of an `isError` property — verified through the real
  agent loop), so failed dispatches reach the model as error tool results.
- **F13 truthful receipts**: `delegated` is claimed only after a child
  process starts; the owning decision ID is captured at admission; parent
  tool calls past the guard mark `local` honestly; status shows admission
  busy/blocked state; `/delegateau status` reports suspected tool shadowing
  (Pi 0.85.1 has no load-time seam to reject duplicate registrations —
  documented limitation, fail-safe runtime detection added).
- Config additions: `childThinking` (explicit child thinking level passed via
  `--thinking`), new limits `maxExpectedOutputChars`/`maxGatePromptChars`.
- Receipts record `servedModel`/`requestedModel` alongside the applied model
  so provider substitution is visible.

### Commands and observed results

- `npm run check` — passed at 2026-09-19 17:09 CEST: TypeScript build
  succeeded; **11 test files / 69 tests passed**.
- Suite verified hermetic: `env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL`
  runs green (credential-dependent behavior removed).
- All review probes re-run against the fixed `dist/`: fail-open scenarios A/B
  now BLOCKED, steering/settlement probe shows regeneration + full restore
  with zero orphaned rejections, project-trust probe throws instead of
  executing the payload, substitution probe reports served evidence,
  false-delegated receipts corrected, descendants swept on normal exit and
  cancel, incomplete stop reasons classified as failures, probabilities
  filtered to candidates.
- Known limitation documented: duplicate `delegate_task` registration from a
  competing extension cannot be rejected at load time on Pi 0.85.1 (no seam);
  detected at runtime via status instead.

## 2026-09-19 19:46 CEST — M7/M8 child extensions, parallel queue and batches

- Read the authoritative specification, development plan and work log before
  implementation, then read Pi 0.85.1's complete `extensions.md`, `packages.md`
  and `settings.md` references plus the requested pi-subagents 0.19.0 research
  and source sections. Updated `SPEC.md` first with R12/R13 and T18–T20, then
  added M7/M8 and coverage rows to `DEVPLAN.md`.
- Added per-agent `childExtensions`. `src/child-extensions.ts` delegates package
  precedence/filter/layout resolution to Pi's own `SettingsManager` and
  `DefaultPackageManager`, then verifies each owning package's concrete
  `pi.extensions` entry. Missing/disabled/ambiguous entries fail closed;
  pi-delegateau is rejected by package/root identity.
- Kept `--no-extensions` and added only resolved absolute `-e` entries.
  `src/pi-process.ts` now runs a bounded isolated RPC registration probe and
  validates requested extension tools against Pi's runtime `sourceInfo`.
  `delegate_task` remains forbidden and absent/empty allowlists emit no `-e`.
- Replaced the single lock with the finite `DispatchAdmission` slot pool and
  FIFO queue. Queued abort removes/wakes exactly once, running abort settles
  through the normal path, and the lease's idempotent `settle` is the only
  release/degrade operation. Status includes running, blocked and queued counts.
- Added the compatible `assignments` batch form. Each element has its own
  dispatch ID, queue/selection/child lifecycle and receipt; results remain in
  input order and mixed failures preserve sibling results/receipts.
- Split dispatch orchestration into `src/dispatch.ts`, reducing `src/index.ts`
  from 34,763 to 27,968 bytes rather than growing the entry point. Added the
  requested pi-subagents attribution notice/license; no reference code was
  copied.

### Commands and observed results

- Hermetic full suite:

  ```text
  $ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
  > npm run build && npm test
  > tsc -p tsconfig.json
  Test Files  12 passed (12)
  Tests       80 passed (80)
  Duration    86.78s
  ```

- Real manifest resolution against this machine's Pi settings:

  ```text
  $ node --input-type=module - <<'EOF'
  import { resolveChildExtensions } from './dist/src/child-extensions.js';
  for (const names of [[], ['pi-lens'], ['donsetch'], ['pi-ollama-cloud-link']])
    console.log(JSON.stringify({names,result:await resolveChildExtensions(names,'/home/nazar/.local/share/pi-delegateau-setup/live')}));
  EOF
  {"names":[],"result":{"paths":[],"packageNames":[]}}
  {"names":["pi-lens"],"result":{"paths":["/home/nazar/.pi/agent/npm/node_modules/pi-lens/dist/index.js"],"packageNames":["pi-lens"]}}
  {"names":["donsetch"],"result":{"paths":["/home/nazar/.pi/agent/npm/node_modules/donsetch/pi-extension.ts"],"packageNames":["donsetch"]}}
  {"names":["pi-ollama-cloud-link"],"result":{"paths":["/home/nazar/.pi/agent/npm/node_modules/pi-ollama-cloud-link/index.ts"],"packageNames":["pi-ollama-cloud-link"]}}
  ```

- Live registered extension path, using config under
  `/home/nazar/.local/share/pi-delegateau-setup/live/feature-proof` and real
  parent/child providers:

  ```text
  $ pi --offline -a --no-extensions -e /home/nazar/src/pi-delegateau/src/index.ts \
      --tools delegate_task --model ollama-cloud/glm-5.3-flash --mode json \
      --no-session -p 'Call delegate_task exactly once with agent "extended" and task "Do not call any tool. Report the exact tool names available to you, comma-separated, and nothing else." Then return the child output verbatim.'
  Dispatch 9fe4f5e3-b4b5-40e3-812c-c8971bf8880b: success
  Selection: fixed (ollama-cloud/deepseek-v4.1-flash)
  Child output:
  read, lens_diagnostics
  ```

- The same real command with `agent "builtin"` (no `childExtensions`):

  ```text
  Dispatch d9c04035-ee77-4ada-81a0-451b4c6b5e11: success
  Selection: fixed (ollama-cloud/deepseek-v4.1-flash)
  Child output:
  read, grep
  ```

- The same real command with `agent "broken"` configured with
  `childExtensions: ["definitely-not-installed"]`:

  ```text
  Dispatch 5059b791-8eaf-40cd-843a-5bedb8e44336: launch-error
  Child extension "definitely-not-installed" could not be resolved from Pi package settings
  ```

- Live batch command (same Pi flags) asked for one batch call containing tasks A,
  B and C at `concurrency: 2`. Extracting real `tool_execution_update` details
  from `parallel.jsonl` produced:

  ```text
  {"dispatchId":"bc611f50-9fbc-498e-9e39-77b7ed23a8e1","status":"queued","at":"2026-09-19T17:40:28.497Z","queuePosition":1}
  {"dispatchId":"fa58e662-27e7-47bd-8572-efdb41745a5a","status":"running","at":"2026-09-19T17:40:28.499Z"}
  {"dispatchId":"8fb428d5-4ac8-42ba-ac16-bee563067161","status":"running","at":"2026-09-19T17:40:28.500Z"}
  {"dispatchId":"fa58e662-27e7-47bd-8572-efdb41745a5a","status":"settled","at":"2026-09-19T17:40:31.395Z","outcome":"success"}
  {"dispatchId":"bc611f50-9fbc-498e-9e39-77b7ed23a8e1","status":"running","at":"2026-09-19T17:40:31.396Z"}
  {"dispatchId":"8fb428d5-4ac8-42ba-ac16-bee563067161","status":"settled","at":"2026-09-19T17:40:33.864Z","outcome":"success"}
  {"dispatchId":"bc611f50-9fbc-498e-9e39-77b7ed23a8e1","status":"settled","at":"2026-09-19T17:40:34.239Z","outcome":"success"}
  Assignment 1: success (fa58e662-27e7-47bd-8572-efdb41745a5a)
  Assignment 2: success (8fb428d5-4ac8-42ba-ac16-bee563067161)
  Assignment 3: success (bc611f50-9fbc-498e-9e39-77b7ed23a8e1)
  ```

  The first two running intervals overlap from 17:40:28.500 until at least
  17:40:31.395. The third remained queued at position 1 and started one
  millisecond after a verified settlement; it did not receive a busy result.

- One attempted parent smoke with
  `--model openai-codex/gpt-5.4-mini` did not dispatch: the live provider
  returned `The 'gpt-5.4-mini' model is not supported when using Codex with a
  ChatGPT account.` The successful evidence above therefore uses ollama-cloud;
  this provider-specific failure is not counted as feature evidence.

### Remaining work

- No feature-A/B implementation blocker remains. T18–T20 are DONE in the
  authoritative coverage table. The older T12 fixed-versus-Jev comparative
  pilot and unrelated pre-existing partial gate/installation evidence remain
  as recorded; this work did not claim to complete them.

## 2026-09-19 20:47 CEST — decision-receipt privacy hardening

- Reproduced a raw remote-body leak through the real gate invalidation and
  decision-receipt builder path. Before the fix, the serialized receipt had a
  categorized `reason` but retained the full body in `invalidationReason` and
  reported `RAW_REMOTE_TEXT_PERSISTED=true`.
- Removed the unreachable UI-sanitization fallback from decision `reason` and
  made both decision error fields classify directly to the stable receipt
  category union. Kept raw gate details available in the in-memory decision/UI.
- Moved dispatch `fallbackCause` classification into `buildReceipt` rather than
  relying on its caller, closing the same bug class at the persistence boundary.
- Added behavioral regressions for gate invalidation and dispatch fallback
  receipts. The new invalidation test was red before the production change:
  **1 failed / 7 passed**, on the category assertion for `invalidationReason`.

### Commands and observed results

```text
$ npm test -- --run tests/receipts.test.ts   # before production fix
Test Files  1 failed (1)
Tests       1 failed | 7 passed (8)

$ npm test -- --run tests/receipts.test.ts   # after production fix
Test Files  1 passed (1)
Tests       9 passed (9)

$ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
> npm run build && npm test
> tsc -p tsconfig.json
Test Files  12 passed (12)
Tests       83 passed (83)
Duration    20.06s
```

- Re-running the original Node probe after the build produced categorized
  `reason` and `invalidationReason` values and
  `RAW_REMOTE_TEXT_PERSISTED=false`.

## 2026-09-19 22:35 CEST — live provider data, difficulty axis, turn-budget fix

Implemented in-tree (NOT via the delegateau/Pi extension) because the extension's
own candidate pool was the thing under repair: running it through Pi would have
burned quota to fix the component wasting quota.

### Fixed: the chooser was routing on invented numbers

`src/jev.ts` built the choice criteria as `criteria[key] = candidate.description`
— prose typed by a human. Measured against the provider's own registry on this
machine, the hand-authored prices in `.pi/delegateau.json` were wrong for 8 of 12
candidates, including a 20x INPUT overstatement:

```text
ollama-cloud/nemotron-3-super  authored input=0.3   live input=0.015  <-- wrong 20x
ollama-cloud/kimi-k3          authored 1.2/4.8     live 3/15         <-- wrong 60%/68%
openai-codex/gpt-5.5          authored 1.25/10     live 5/30         <-- wrong 75%/67%
ollama-cloud/glm-5.3          authored 0.6/2.4     live 1.4/4.4      <-- wrong 57%/45%
```

Root cause of the wasted quota: measured dispatches spent 26,408 INPUT tokens
against 1,307 output — 95% of tokens are input — so cost is (context size) x
(input price), and input prices across the pool span ~200x. A model picked on an
unverified "large reasoning model" description at $3/M input can spend a whole
child budget just re-reading its own instructions.

New `src/live-data.ts` resolves each candidate against Pi's model registry, which
the provider extension already populates with `{input, output, cacheRead,
cacheWrite}`, `contextWindow`, `maxTokens`, `reasoning` and input modalities.
Precedence is provider-first; a config-authored figure survives only where the
provider declares nothing and is then labelled `costSource: "user"` so the
chooser is told the number is unverified. Unknown stays unknown.

Verified live — the chooser's criteria now read (real values):

```text
ollama-cloud/glm-5.3-flash       price $0.15/M in, $0.5/M out (provider catalog) | context 1049K | ...
ollama-cloud/nemotron-3-super    price $0.015/M in, $0.6/M out (provider catalog) | ...
```

### Added: a difficulty axis and cost-of-failure

`preference` ("balanced") is not a difficulty signal. The gate now asks a second
Choice question in the SAME TypeSafe call — six ordinal levels modelled on
switchyard's classification, each with its conventional thinking effort
(trivial/minimal … frontier/max). One bounded sensing operation yields both
answers, and an unrecognised level is dropped rather than coerced into a routing
input. The judged level travels with the decision into the chooser.

The gate state also carries a bounded, non-source repository profile (directory
names, file count, safe manifest metadata, context-file names — never file
contents or conversation history) and an explicit statement of what a wrong
answer costs, implementing `expected cost = token cost + P(failure) x cost of
failure`.

### Fixed: the turn budget discarded completed work

`src/runner.ts` aborted whenever the turn COUNT passed the limit, regardless of
whether that turn had finished — so a child that produced its final answer on the
last allowed turn was killed and relabelled `limit-exceeded`. Observed live: a
worker burned 13,564 output tokens and was reported as limit-exceeded with its
work discarded. The budget now aborts only when the turn signals CONTINUATION
(`toolUse`), which is the only case that can lead to further inference. Raised the
default `childMaxTurns` 40 -> 120 (wall time remains the binding envelope).

### Commands and observed results

```text
$ npx tsc -p tsconfig.json --noEmit          # clean

$ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
Test Files  13 passed (13)
Tests       97 passed (97)

# red-on-base proofs, each by reverting only the production change:
$ npx vitest run tests/runner.test.ts        # base:  1 failed | 11 passed
$ npx vitest run tests/live-data.test.ts     # base:  2 failed | 10 passed

# live gate: complexity returned alongside the recommendation, one call
{"source":"jev","recommendation":"local","complexity":"advanced",
 "confidence":0.33,"restriction":"none","latencyMs":779}
```

Removed `npm:opencode-pi` from Pi settings: its 8 zen models are advertised in the
catalog but every one returns a server-side `403 FreeTierError`
("OpenCode's free tier can only be used from within OpenCode"). Isolated the
trigger — an all-deny agent permission block leaves the request with no tool
definitions, which is the actual discriminator. Not a client-shape problem, so no
workaround exists that is not circumventing a paid-tier check. The standalone
`opencode` CLI remains installed and its free models do answer directly.

## 2026-09-19 23:53 CEST — setup-aware cost metering, and credential add/remove verified live

### The cost axis depends on how the account is SET UP, not the provider name

Resolved in this precedence (new `src/quota.ts`):

1. Explicit config (`costMode.providers`, `costMode.ollamaPlan`) — only the user
   knows their plan.
2. Detected plan, read from the account's own telemetry.
3. Auth shape via Pi's exported `readStoredCredential()`: `oauth` = subscription
   login, `api_key` = key.
4. Default per-token for a provider not yet configured.

API price is retained on BOTH axes as the general trendline (a huge model really
does cost more than a small one); a measured quota multiplier overlays it on
quota-metered plans rather than replacing it. This corrects an earlier iteration
that dropped price entirely on the Ollama plan, which was an overcorrection.

### Auth shape CANNOT distinguish the two Ollama plans

Measured: this account's `ollama-cloud` credential is `type: api_key`, because the
key is generated at ollama.com → Settings, exactly as a new-plan user's would be.
So `oauth` vs `api_key` says nothing about grandfathered-vs-credit-based.

The discriminator is the account data itself:

```text
GET /api/usage  ->  activity.cost = '0.00000'
                    limits buckets = ['session','weekly']
```

Zero dollar cost alongside active quota buckets means usage is metered as GPU
time, not dollars. A credit-based plan would report real spend, because its usage
IS priced. `detectOllamaPlan()` reads the `/api/usage` snapshot the sibling
package (`pi-ollama-cloud-link`) already writes, rather than making its own call.

Live verification against the real account:

```text
ollama-cloud  auth=api_key  -> quota-gpu-time  (detected-plan)
openai-codex  auth=oauth    -> token           (detected-subscription)
```

Documented limitation: that snapshot only exists after the sibling package has
fetched during a session, so cold-start detection is unavailable. Hence the config
override, and hence price is never dropped — a failed detection degrades to the
trendline rather than to a wrong axis.

### Credential add/remove verified end to end (live)

Tested by actually mutating `~/.pi/agent/auth.json` (backed up first, sha256
recorded, restored byte-identical and re-verified callable):

```text
BASELINE          ollama-cloud 8/8 eligible   openai-codex 4/4 eligible
OPENAI REMOVED    ollama-cloud 8/8 eligible   openai-codex 0/4 eligible
OPENAI RE-ADDED   ollama-cloud 8/8 eligible   openai-codex 4/4 eligible
```

The gate reflects it too — with the credential removed, a live gate call offered
Jev only `["ollama-cloud/deepseek-v4.1-flash"]`, so a removed provider's models
leave the chooser's options, and adding a provider adds them. Because the
resolver runs per dispatch (not cached at install), a provider configured AFTER
the extension is installed is picked up with no reinstall or restart.

### Cost clause the chooser now receives (live, real pool)

```text
deepseek-v4.1-flash  uses the least quota of any model here (user-reported; published price $0.3/M in ... rough trendline here)
glm-5.3-flash        costs about 3.5x the cheapest model in quota (user-reported; published price $0.15/M in ... rough trendline here)
gpt-5.6-luna         $0.2/M in, $1.2/M out (per-token billing)
kimi-k3              quota cost not yet measured on this plan; treat the published price as a rough trendline only ($3/M in, $15/M out)
```

### Commands and observed results

```text
$ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
Test Files  15 passed (15)
Tests       124 passed (124)
```

Known limitation: the injection parameter for tests cannot distinguish "credential
absent" from "not supplied" (both are `undefined`); the production path calls
`detectAuthType` directly and returns `undefined` for an absent credential, which
correctly reaches the `default` branch.

## 2026-09-20 00:30 CEST — quota-aware eligibility and Jev pressure

Implemented the automatic quota path separately from manual Hermes quota handling.
The extension now reads provider-owned snapshots at request/dispatch resolution:
Ollama's `limits.<window>.usage` and Codex-style `rate_limit.*_window.used_percent`
normalize to the same provider/window/headroom shape. Missing state remains unknown;
no current account quota values or per-model measurement pass were hardcoded.

- Added a provider-level hard exhaustion floor of 2% remaining. Any observed session,
  weekly, or monthly window at the floor excludes every model from that provider
  before the gate/chooser sees it; dispatch revalidates the filter before launch.
- Added bounded soft pressure to both Jev Choices: each known window's remaining
  percentage and reset metadata are included, while providers without a snapshot are
  explicitly labelled unknown rather than healthy/unlimited.
- Current live snapshot verification (read-only) reported
  `ollama-cloud`: weekly 3.8% remaining, session 88.9% remaining. At the 2% hard
  floor both Ollama and OpenAI-shaped candidates remain eligible; Jev receives the
  3.8% weekly pressure instead of a hardcoded OpenAI comparison.

$ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
> pi-delegateau@0.1.0 check
> npm run build && npm test

Test Files  15 passed (15)
Tests       128 passed (128)

$ node --input-type=module -e 'readQuotaState(); filterCandidatesByQuota(...)'
{"ollama-cloud":{"session":88.9,"weekly":3.8}}
ollama-cloud quota headroom: weekly 3.8% remaining, session 88.9% remaining
eligible candidates: ollama-cloud/deepseek-v4.1-flash, openai-codex/gpt-5.6-luna
```

No live child dispatch was run because the change is specifically intended to avoid
spending the near-exhausted provider bucket.

## 2026-09-20 01:30 CEST — onboarding bootstrap implementation

Pi-assisted implementation added an explicit `/delegateau setup` flow and a focused
`src/onboarding.ts` module. It discovers authenticated models from Pi's live registry,
projects provider metadata into a reviewable candidate pool, provides the six built-in
roles (`scout`, `researcher`, `evidence-auditor`, `worker`, `reviewer`, `oracle`),
enables the web roles when either `pi-web-access` or `donsetch` is installed, preserves exact model IDs, and
writes `.pi/delegateau.json` only after confirmation.

The setup review is side-effect-free. `/delegateau setup probe` is an explicit sequential
reachability stage; quota measurement remains opt-in and was not run. External benchmark
ingestion and provider-specific account-mode adapters remain input boundaries rather than
invented live claims; unknown evidence is retained and labelled.

Observed verification:

```text
$ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
Test Files  16 passed (16)
Tests       137 passed (137)

$ node --input-type=module -e '...generated setup config smoke...'
{"candidateCount":1,"roles":["scout","researcher","evidence-auditor","worker","reviewer","oracle"],"selection":"jev","hasSecrets":false}
```

Session startup remains side-effect-free; only the explicit setup probe path performs
online reachability checks. Quota measurement was not run.

## 2026-09-20 01:51 CEST — web extension eligibility correction

The two web-research roles now accept either installed `pi-web-access` or `donsetch`,
select the available extension in generated child configuration, and remain unavailable
when neither is present. The built artifact was smoke-tested with the installed donsetch
package; both roles selected `donsetch` and no internal eligibility marker was serialized.

## 2026-09-21 — stale per-model reachability expiry

A real dispatch excluded `openai-codex/gpt-5.6-luna` despite live registry/auth readiness
because its cached negative reachability result was more than a day old. The cache file's
top-level timestamp could be fresh after merging while the individual result stayed stale;
`isKnownUnreachable()` treated every negative entry as permanent.

- `src/reachability.ts` now excludes a negative result only when that result's own
  `probedAt` is valid, not future-dated, and younger than 24 hours. Stale, missing,
  malformed, and future timestamps are treated as unprobed. Positive entries never exclude.
- Added deterministic injected-clock tests for fresh, stale, exact-boundary, missing,
  malformed, future-dated, and mixed-entry cases. `dist/` was rebuilt.
- Red-on-base: the new freshness contracts failed against the pre-fix production source
  (**6 failed / 12 passed**). Fixed tree: `env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check`
  passed (**18 test files / 158 tests**).
- Live Pi dispatch after the fix succeeded with Jev selection; all **12/12** configured
  candidates were eligible and `openai-codex/gpt-5.6-luna` was included in the chooser's
  probability map.

## 2026-09-21 — persistent runtime health circuits and safe route trace

Implemented the requested reliability ideas without adopting any continuous
parent-model switching. The parent model and conversation are never touched.

- Added `src/health.ts`: pure circuit transitions with stable categories
  (`unsupported-model`, `auth`, `quota`, `timeout`, `network`,
  `provider-stream`, `launch`, `cancellation`, `task-failure`, `cleanup`,
  `unknown`). Defaults are 3 failures / 5 minutes / 60 minutes; a half-open
  trial failure reopens with bounded backoff (x2 capped at 16x). Cancellation,
  ordinary task failure and cleanup failure never count. `classifyChildHealth`
  only blames an applied model after the child actually started.
- Added `src/health-store.ts`: atomic human-readable JSON under the Pi agent
  state area (`<agentDir>/delegateau/health.json`) with an injectable io/clock
  seam. Missing, corrupt or malformed state fails open; `enabled: false` is
  fully transparent.
- Added `src/eligibility.ts`: one candidate resolver shared by the gate and
  dispatch, folding registry/auth, quota floor, reachability and the health
  circuit together and returning excluded candidates with stable reasons.
- Added `src/route-trace.ts`: bounded, structured trace (dispatch/decision IDs,
  agent, candidate ids, excluded reasons, selection source,
  requested/selected/applied/served model, Jev latency/confidence,
  quota/reachability/health filter facts, outcome/error category, timestamps)
  embedded in the existing receipt path. Its builder has no parameter for task,
  prompt, context, output, repository contents, secrets or provider bodies.
- Wired health at the real dispatch path: the circuit is filtered before Jev,
  revalidated before launch, one half-open trial is claimed before spawn, and
  the outcome is recorded against the APPLIED model while the receipt retains
  requested and applied identities. `/delegateau status` now reports the open
  circuit count with sanitized model/category/cooldown facts.
- Reused the previously uncommitted reachability freshness behavior unchanged.

### Commands and observed results

```text
$ npx vitest run tests/extension-entry-health.test.ts   # before the production fix
Test Files  1 failed (1)
Tests       2 failed (2)
# expected launch-error on the first provider failure; no health file existed

$ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
> npm run build && npm test
Test Files  23 passed (23)
Tests       194 passed (194)
```

- New behavioral coverage: `tests/health.test.ts`, `tests/health-store.test.ts`,
  `tests/eligibility.test.ts`, `tests/route-trace.test.ts`, and
  `tests/extension-entry-health.test.ts` (registered `delegate_task` path:
  persistence + pre-Jev filtering, applied-model substitution, status surface).
- Incomplete live evidence: no real provider-backed dispatch was run for this
  change; the entry-path tests use a real spawned child executable fixture.
  Reachability's 24-hour per-result freshness is unchanged and its pre-existing
  live note above still applies.

## 2026-09-21 — post-agent verification hardening

- Independently reran `env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check`:
  **23 test files / 194 tests passed**; `git diff --check` is clean.
- Corrected the child-health boundary: `timed-out` is delegateau's wall-clock
  envelope and is therefore a task failure, not proof of a provider timeout.
  Provider timeout evidence still uses the failed-result error category.
- Shared the in-process `HealthStore` across dispatches with the same project and
  health configuration, preventing concurrent parent calls from overwriting each
  other's in-memory failure events before persistence.
- Rebuilt `dist/` through the full check; focused health/eligibility/trace and
  registered-entry tests pass (**5 files / 36 tests**).

## 2026-09-24 — M10 / T22 benchmark-evidence pipeline

Finished the uncommitted benchmark-evidence work in place (no clean tree). The
feature adds an explicit, bounded, side-effect-free pipeline from acquisition to
Jev and the receipt, and keeps every unknown visibly unmeasured.

### What it does

- **Normalized record:** one `BenchmarkEvidence` shape (exact `provider/model`,
source id, HTTPS URL, benchmark, version, metric, observation date,
provider/independent provenance, finite score, unit, direction).
`normalizeBenchmarkDocument` validates length/count/date/URL bounds, exact-dedupes,
preserves unlike metrics/versions, and emits only bounded category diagnostics
(`malformed`, `stale`, `future-dated`, `unmatched-model`, `unsafe-source-url`,
`limit-exceeded`, `source-unavailable`).
- **Agent-state cache, not policy config:** validated results persist at
`<agentDir>/delegateau/benchmarks.json`. Every setup review revalidates the cache
against the current live authenticated registry and clock (`revalidateBenchmarkCache`),
so a record that aged out or lost its live identity is demoted to a diagnostic.
- **Explicit commands** (the only evidence-acquiring paths): `/delegateau setup
import <file>` is a local JSON import with no network seam; `/delegateau setup
retrieve artificial-analysis <mapping-file>` calls the documented Free-tier
`GET https://artificialanalysis.ai/api/v2/language/models/free` with
`ARTIFICIAL_ANALYSIS_API_KEY` from the process environment and an explicit
user-authored stable-`id` → exact Pi identity map. It never guesses aliases.
Import, extension load, session start, ordinary review, and dispatch issue no
benchmark request.
- **Runtime carry:** `setupConfig` → `parseConfig`/`CandidateProfile` → eligibility
enrichment → Jev `state.candidates[].benchmarks` + per-candidate criteria facts →
the dispatch receipt's `routeTrace.benchmarks` with an exact bounded record list
and `offeredToJev` (true only when the model chooser actually ran; fixed/pin/
single-candidate records it as false). No raw body, task text, credential, or URL
query/fragment is retained.
- **Dominance unchanged in spirit, stricter in comparison:** pruning only compares
records identical on source/benchmark/version/metric/unit/direction and never
removes a candidate that lacks evidence.

### Research basis (primary sources)

- `docs/artificialanalysis.ai/data-api/docs`: base URL
`https://artificialanalysis.ai/api/v2`, `x-api-key`, Free endpoint
`/language/models/free`, stable model/creator IDs preferred.
- `artificialanalysis.ai/data-api/migrate-v2-data`: legacy
`/api/v2/data/llms/models` retires 2026-11-04; the adapter uses the supported
Free replacement and never the legacy path.

### Red/green evidence (strict vertical slices)

```text
$ npx vitest run tests/benchmark-retrieval.test.ts    # before the module existed
Error: Cannot find module '../src/benchmark-retrieval.js'   # red
# after implementation: 5 passed

$ npx vitest run tests/extension-entry-benchmark.test.ts   # before dispatch wiring
Tests  2 failed (routeTrace.benchmarks undefined)          # red
# after wiring: 2 passed (incl. real TypeSafe SDK transport, offered:true)

$ npx vitest run tests/extension-setup-benchmark.test.ts   # before command wiring
Tests  3 failed (setup fell through to review)             # red
# after wiring: 3 passed

$ env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
Test Files  27 passed (27)
Tests       214 passed (214)
```

### Live evidence (real runs, not fixtures)

- Registered `delegate_task` scout dispatch succeeded under Jev selection
(`ollama-cloud/deepseek-v4.1-flash`); the tool result returned child output.
- AskJev judgment: `ask_jev_noul` answered with model `jev-1.13.0`, probability
0.77, 405/20 tokens. `receiptsEnabled:false` was set for this ephemeral call via
an askjev config that was removed after the call. The `ask_jev_choice` primitive
returned `invalid_response` on this host.
- Fresh Pi **0.87.1** headless run in an isolated project, loading the updated
`src/index.ts` plus the peer extensions with `--no-extensions --no-lsp`:
Jev chose the child, the child ran (health success recorded), and the receipt
contained `selectionSource: jev`, `offeredToJev: true`, and the exact synthetic
`T22SyntheticContract` record. Evidence at
`/home/nazar/.hermes/cache/scratch/t22-live-20260924T140403Z/`.

### Gaps and boundaries

- No live Artificial Analysis retrieval: `ARTIFICIAL_ANALYSIS_API_KEY` is absent
from the process environment. The authenticated adapter is verified with injected
fake fetch plus a local-credential path test; the real AA call remains pending and
T22 stays PARTIAL. No AA body was read or invented.
- Host Pi is 0.87.1 while the package peer range is `>=0.85.1 <0.86.0`; the updated
extension loaded and dispatched successfully on 0.87.1, but that is outside the
declared peer range.
- `pi-fast-jev-compaction` loaded without error in the headless run, but no manual
`compact`/`compaction_end` RPC evidence was captured in this implementation
session.

## 2026-09-24 — T22 review-fix hardening (uncommitted, TDD)

Applied the four independently-reviewed benchmark-pipeline fixes in place, in
strict red/green vertical slices; no commit/push. Scratch evidence with the raw
test output: `/home/nazar/.hermes/cache/scratch/pi-delegateau-review-fixes-evidence.md`.

1. **AA metric semantics + date provenance.** `src/benchmark-retrieval.ts` no
   longer promotes every numeric `evaluations` field. `ALLOWED_ARTIFICIAL_ANALYSIS_METRICS`
   admits only the documented Free-tier composite indices (Intelligence, Coding,
   Agentic); the `intelligence_index_version` is used only for the Intelligence
   Index, the coding/agentic indices are "not separately versioned", and every
   other numeric field becomes a bounded `unsupported-metric` diagnostic. Red:
   received `mmlu_pro`/`some_undocumented_metric` records; green: 2 records + two
   `unsupported-metric` diagnostics. `BenchmarkEvidence` gained a required
   `dateKind: "source-reported" | "retrieval-snapshot"`; AA records are
   `retrieval-snapshot`, local import/config records are `source-reported`, and
   the route trace and Jev facts carry it.
2. **Bounded retrieval.** `RetrievalFetchResponse` exposes a raw body stream;
   the adapter counts bytes chunk-by-chunk, cancels at the first chunk that
   crosses the 1MB cap, and only then decodes/parses the bounded body. A single
   `withDeadline` window (default 10s, hard max 30s, `timeoutMs` override) covers
   fetch and streaming with an AbortController. Red: hung transport timed out
   2000ms; hung body timed out; oversize returned `malformed`, and an unbounded
   stream was consumed via `text()`. Green: `source-unavailable` for hung,
   `oversize` for oversized body, and streaming test proves the body is cancelled
   without calling `text()` or draining the remainder. Credentialed command path
   writes no cache when no records are normalized.
3. **Cache revalidation before merge.** `mergeBenchmarkReport` now takes
   `{ knownModels, now }` and revalidates prior records via
   `revalidateBenchmarkCache` before appending the report and applying the
   8/model cap. Red: 8 stale prior records crowded out the fresh import; green:
   the fresh record is the only retained record.
4. **Exact dedup.** `benchmarkRecordKey` now includes `date` and `score`; the
   separate `benchmarkComparisonKey` (source/benchmark/version/metric/unit/
   direction/provenance) remains the dominance/pruning key. Red: three distinct
   observations collapsed to one; green: all three retained.

Canonical check after the final source/test edits: `env -u TYPESAFE_API_KEY -u
TYPESAFE_BASE_URL npm run check` -> TypeScript build green, **27 files / 221
tests passed**; `git diff --check` clean. T22 stays **PARTIAL**: the absence of a
real `ARTIFICIAL_ANALYSIS_API_KEY` is explicit, no live AA call was made, and no
AA body was read or invented. The only non-benchmark edit was a one-line,
test-only type correction in `tests/jev.test.ts` (adding the already-required
`complexityQuestion` argument to an existing delegation-choice test); tests are
excluded from the build.

## 2026-09-25 — global config, project override

- Standardized with `pi-askjev`: delegateau previously read only `<cwd>/.pi/delegateau.json`
  and had no user-level config, so every project needed its own copy.
- `src/config.ts` now exposes `resolveConfig({ cwd, agentDir?, env? })` → `{ config, source, path }`
  with the order **project → global (`<agent-dir>/delegateau.json`) → defaults**. The agent dir is
  `PI_CODING_AGENT_DIR`, else `~/.pi/agent`, the same root `defaultReceiptPath()` already used.
  A project config REPLACES the global one rather than merging, and an unreadable file at either
  level still fails closed instead of silently falling back to defaults. `loadConfig(cwd)` remains
  as a thin wrapper so existing call sites keep their behavior.
- `/delegateau status` now reports the effective source and path. Real Pi RPC run from a directory
  with no `.pi` config: `config=global (/home/nazar/.pi/agent/delegateau.json)` with the global
  pool in effect (10 candidates, agents worker+scout, `delegation decision=jev-enforce`).
- Red before green (`evidence/delegateau-global-config-red.txt`): the six new resolution tests
  failed with `resolveConfig is not a function`; after implementation, 15/15 pass in
  `tests/config.test.ts` (`evidence/delegateau-global-config-green.txt`).
- Canonical `env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check`: build clean;
  **27 files / 228 tests passed** (was 222; +6 resolution tests).
- Operator side: the global config is now `/home/nazar/.pi/agent/delegateau.json`, derived from the
  hand-maintained askjev project config with the two machine-specific `receiptPath` keys removed so
  receipts fall back to the agent dir. Its 10-candidate pool is the one whose model descriptions
  carry the measured benchmark evidence; the repo-local file still carries the older 12-candidate
  prose pool (including the two Kimi models excluded from routing).
