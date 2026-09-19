# pi-delegateau work log

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
