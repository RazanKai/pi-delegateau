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
