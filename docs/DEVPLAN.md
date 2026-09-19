# pi-delegateau — Standalone Development Plan

## Authority and starting point

Implement the replacement `SPEC.md`: a standalone Pi extension that selects a
model for a delegated assignment and optionally enforces parent delegation.
Selectively adapt pi-foreman patterns; do not fork its workflow or ship it as a
runtime dependency.

This plan replaces the previous development plan in full. Implementation has not
started. All acceptance statuses below are TODO. `WORKLOG.md` remains unchanged
by this rewrite and becomes the chronological record of actual development.

The scope is intentionally sequential: one admitted dispatch per extension
instance, no batches, chains, work queue, worktree management, automatic gates,
validator, planner, or repair loop.

## Development discipline

- Read `SPEC.md`, this plan, and the current work log before implementation.
- Verify live upstream API contracts and pin Pi/TypeSafe versions before coding.
- Prefer supported APIs and small proven source adaptations over a generic
  orchestration framework. No compatibility shims based on guessing argument order.
- Preserve upstream license/copyright notices for copied or adapted portions.
- Keep tests and probes in isolated Pi configuration and disposable workspaces;
  never let extension tests load arbitrary user extensions or mutate live config.
- Do not commit, push, publish, globally install, or change the user's production
  setup without explicit authorization.
- Keep dependency versions bounded and lock the resolved dependency graph.
- Test behavior, actual caller wiring, and failure paths. Do not read source text
  in tests as a proxy for runtime behavior.
- Use explicit synchronization for race/cancellation tests, not narrow sleeps.
- Append commands, results, upstream versions, decisions and blockers to the work
  log as development happens. Never substitute fabricated live results for mocks.
- Update only this plan's acceptance table for authoritative completion status;
  chronological work-log entries are evidence, not a second status registry.

## M0 — Confirm the reuse boundary and extension contracts

**Goal:** establish the smallest independently installable package and verify the
extension seams before adopting source.

Work:

1. Read pi-foreman's exact LICENSE and relevant source at
   `e19a9ad9dce5c304e451e095e5899ddab00b3027`.
2. Compare its mode toggle/dispatch/process patterns with the official subagent
   example on an exact selected Pi release. Choose a single child launch path.
3. Record which portions are adapted versus independently implemented, with source
   revision and required attribution. Exclude gate, validator, plan, diff and
   repo-map code rather than importing it disabled.
4. Verify actual registration signatures, tool name collision behavior, model/auth
   registry access, exact provider/model selection, and tool-call blocking.
5. Verify how a child disables extension tools as well as built-in tools. Establish
   working-directory and project-instruction behavior separately from transcript
   isolation.
6. Check current TypeSafe Choice/SDK contracts, supported Jev catalog identifiers,
   request deadline and cancellation behavior. Do not use an unverified cookbook
   model name or invent an SDK call.
7. Create minimal package metadata, entry point, test runner and isolated Pi
   loading harness. Define documented configuration and command names only after
   resolving the actual APIs.

Exit evidence:

- Package loads in isolated Pi without pi-foreman installed; extension tool and
  status command register and model discovery uses real Pi imports.
- Tool guard is exercised through Pi, including an unapproved dynamically added
  tool. A missing enforcement seam is reported, not replaced with prompt advice.
- Provenance record distinguishes copied code, reused ideas, and excluded modules.
- Typecheck/build/test commands are established and recorded with actual output.

**Acceptance target:** T01. Source inspection alone does not complete integration.

## M1 — Reliable fixed-model dispatch

**Goal:** one real child, explicit identity, truthful completion and cleanup.

Work:

1. Validate configuration and trusted agent definitions. Implement candidate
   eligibility, pins, defaults, fixed selection and single-candidate resolution.
2. Register a generic agent/task delegation tool without model or complexity input.
3. Acquire the dispatch lock before selection; reject overlapping attempts as busy.
4. Launch using the chosen Pi execution path with explicit model, thinking level,
   tools, instructions and cwd. Disable recursive tools/extension loading.
5. Normalize progress, usage and child outcomes. Distinguish provider error,
   process error, cancellation, timeout and successful execution. Bound output.
6. Add cancellation/limits and observed-exit-based termination with descendant
   cleanup on Linux. Cover spawn errors, temporary files, timers and listeners.
7. Add local metadata receipts without private task bodies. Surface applied model,
   not just the requested launch configuration.

Exit evidence:

- Actual extension tool invocation launches a child against a configured live
  provider and verifies a small task in a non-git temporary workspace.
- Parent model is unchanged; child context excludes an unrelated parent sentinel.
- Candidate and pin cases are exercised, including invalid default/pin and no
  eligible model. No sensor call occurs in fixed mode.
- Concurrent tool calls prove one admission; a later call succeeds after confirmed
  cleanup. A cleanup failure remains blocked rather than falsely returning idle.
- Provider error with zero process exit is not marked successful. A normal exit
  is described as execution completion, not automatically verified correctness.
- Cancellation/timeout probes exercise children with descendants, pre-cancelled
  invocations and startup failure; no owned process remains after success claims.

**Acceptance targets:** T02, T03, T04, T08, T11; child/lifecycle portions of T09 and
receipt portions of T10. Keep cross-milestone contracts PARTIAL until complete.

## M2 — Jev chooses the child model

**Goal:** add one bounded semantic selection operation to the working launch path.

Work:

1. Define compact profiles with exact IDs, supplied capability descriptions,
   provenance, known capabilities and optional economic metadata.
2. Build one Choice over eligible candidates from the real resolved task and agent
   definition. Keep trusted policy separate from untrusted task/context data.
3. Bound input; do not load the repository or send parent conversation implicitly.
4. Enforce the total selection deadline and response validation. Handle eligible
   default fallback for sensor failure only, never for cancellation.
5. Revalidate eligibility just before launch. Prevent a late sensor response from
   starting work after cancel or deadline completion.
6. Apply explicit consent for external sensing. Expose missing/misconfigured Jev
   distinctly from successful selection and from a visible runtime fallback.
7. Record selection source, candidate/profile versions, probabilities/confidence,
   sensing usage/latency and applied identity without raw service error leakage.

Exit evidence:

- A live Jev response goes through the registered delegation tool to an actual Pi
  child request with matching applied provider/model.
- Controlled HTTP responses test invalid IDs, malformed output, timeout, service
  error, changed eligibility, and ineligible fallback. Use the real client and
  extension path; isolate only the remote service when making cases deterministic.
- Pin/fixed/single-candidate/disclosure-prohibited paths produce no Jev request.
- Cancellation during sensing cannot fall back, launch late, or leak the admission
  lock after cleanup. Child model remains fixed once execution starts.
- Logging probes use sensitive sentinel values to demonstrate receipts exclude
  task bodies, prompts, credential values and unfiltered error bodies.

**Acceptance targets:** T05, T06; complete T04, T09 and T10 as their full matrix
passes. Credentials/network blockers leave the live T05 criterion incomplete.

## M3 — Optional delegation enforcement

**Goal:** enforce who can execute work without imposing a planning framework.

Work:

1. Adapt pi-foreman's explicit mode-toggle/save/restore pattern, with attribution
   if code is copied. Do not import its `PLAN.md` or `update_plan` machinery.
2. Implement stable `normal`, `delegate-execution`, and `coordinator-only` modes.
3. Use explicit parent allowlists, tool selection before inference, and call-time
   guards. Include bash, interpreters, MCP/custom tools and alternate launchers in
   the restriction analysis; newly registered tools are not auto-approved.
4. Support explicit idle-boundary activation/deactivation and safe restoration of
   the captured tool selection when some tools no longer exist.
5. Keep child tool policy independent. No spawn quotas, per-turn classifier, plan
   injection, automatic verifier, or fallback to unrestricted parent execution.
6. Refuse unsupported enforced modes rather than silently downgrading to guidance.

Exit evidence:

- In delegate-execution mode parent approved reads succeed, direct mutation and
  commands are rejected, and a child performs the requested authorized edit/test.
- Coordinator-only additionally rejects repository reads/searches while permitting
  delegation and user coordination.
- Prohibited dynamically registered tools and alternate launchers cannot bypass
  the call guard. Confirm the limits of enforcement with trusted extensions.
- A conceptual conversation completes without required child invocation.
- Returning to normal restores expected tools and leaves the parent model intact.
- An actual delegated task completes without a git baseline, generated plan file,
  gates configuration, validator or remediation call.

**Acceptance targets:** T07; rerun T02, T08 and T11 through the enforced-mode path.

## M4 — Package, compare, and decide

**Goal:** produce usable installation instructions and evidence about value.

Work:

1. Document supported versions, configuration, profile/pin semantics, modes,
   trust/credential handling, external data exposure, receipt location, limits,
   cancellation guarantees and uninstall/deactivation.
2. Include examples for exploration, implementation and explicit review as normal
   delegated assignments, not built-in role-specific orchestration.
3. Verify clean installation/load without pi-foreman or unrequested global changes.
4. Choose a small fixed set of representative assignments before evaluating.
   Include easy search, bounded edits, debugging, tests, review and ambiguity.
5. Run paired fixed-versus-Jev selection under the same delegation mode, same
   starting workspace, same model pool and independent acceptance checks.
6. Report task outcomes, chooser overhead, total latency, available cost/usage,
   failures and fallback frequency. Account for model randomness; do not interpret
   a tiny pilot as a statistically established ranking.
7. If testing more aggressive delegation, hold selection constant and report that
   comparison separately. No need to build another evaluation service.

Exit evidence:

- All unit/integration checks pass, plus live Jev-to-child smoke and a real
  non-git-workspace task. Record missing live evidence honestly.
- Installation instructions work in a clean isolated environment.
- A reproducible pilot report includes failures, unknown costs and sensing overhead.
- Recommend keeping the selector, changing profiles, or using fixed selection on
  observed evidence. Savings are a hypothesis, not a release checkbox.

**Acceptance target:** T12, followed by a full acceptance review.

## Acceptance coverage — authoritative status

Statuses: TODO = not implemented/proven; PARTIAL = named subset verified; DONE =
all clauses verified with concrete test/run evidence. Add actual file/symbol/test
or artifact references when updating. Milestone ownership is not evidence.

| Contract | Requirements | Owner milestones | Status | Evidence / remaining work |
| --- | --- | --- | --- | --- |
| T01 | R01 | M0, M4 | PARTIAL | `package.json`, `src/index.ts`, `NOTICE.md`, and `THIRD_PARTY_LICENSES/pi-foreman-MIT.txt` provide a standalone package and attribution; `PI_OFFLINE=1 ./node_modules/.bin/pi -e ./src/index.ts --list-models` exits 0 without pi-foreman, and a packed tarball installs into a clean `/tmp` consumer with Pi peer metadata. Production Pi installation remains unperformed. |
| T02 | R02, R07 | M1, M3 | PARTIAL | `src/index.ts` registers `delegate_task`; `src/runner.ts` normalizes provider errors, applied-model evidence, and statuses; `tests/pi-process.test.ts` exercises a real spawned JSON child. A live configured provider dispatch remains. |
| T03 | R02, R08 | M1, M2 | PARTIAL | `tests/admission.test.ts` proves single admission and blocked cleanup; `src/index.ts` holds the lease through selection/run/cleanup. Concurrent Pi invocation and cleanup-failure E2E remain. |
| T04 | R03, R05 | M1, M2 | PARTIAL | `tests/selection.test.ts` covers pin/fixed/single/empty/fallback/cancel precedence; `src/index.ts` revalidates Pi registry/auth eligibility. Full live registry matrix remains. |
| T05 | R04, R07 | M2 | TODO | `src/jev.ts` implements the verified TypeSafe SDK `0.6.0` Choice shape, but no credentialed live Jev-to-child run was performed. |
| T06 | R03, R05 | M2 | PARTIAL | Selector tests cover sensor failure, invalid choice fallback, and cancellation; entry point revalidates after selection. Controlled HTTP and late-response entry-path probes remain. |
| T07 | R06 | M3 | PARTIAL | `src/mode.ts`, `src/index.ts`, and `tests/extension.test.ts` cover explicit active-tool selection and call-time blocking, including unknown tools. Real Pi dynamic-tool bypass probes remain. |
| T08 | R02, R07 | M1, M3 | PARTIAL | `src/pi-process.ts` uses `--no-session`, `--no-extensions`, explicit model/tools, and assignment-only prompt data; `tests/pi-process.test.ts` verifies the real JSON launch flags and model evidence. A live sentinel-isolation child run remains. |
| T09 | R05, R08 | M1, M2 | PARTIAL | `src/runner.ts` handles pre-cancel, wall-time, turn limit, signal propagation, and observed close; `tests/pi-process.test.ts` proves a real wall-time timeout returns only after observed cleanup; `session_shutdown` aborts owned dispatches. Descendant cleanup and shutdown E2E remain. |
| T10 | R09 | M1, M2 | PARTIAL | `tests/receipts.test.ts` proves payload omission and secret sanitization; receipts are JSONL and Jev is skipped when prohibited. Full entry-path disclosure probes remain. |
| T11 | R01, R07, R10 | M1, M3 | TODO | No real delegated task has been run in a disposable non-git workspace yet. |
| T12 | R09, R10 | M4 | TODO | No fixed-versus-Jev pilot has been run. |

## Minimum failure matrix

Cover these through the actual extension entry points, with deterministic fixtures
where appropriate:

- Invalid configuration, unavailable credentials, missing or ineligible pin.
- Empty/one/multiple candidate sets, unknown profile metadata, default unavailable.
- Sensor disabled, remote error, invalid selected ID, slow response, late response.
- Concurrent dispatch attempts and failure during each lifecycle stage.
- Child spawn error, provider error despite zero exit, signal exit, hanging child,
  descendant process, wall-time/turn limit, cleanup failure and session shutdown.
- Prohibited static/dynamic tools, alternate launch tools, mode change while busy.
- Child extension loading, transcript sentinel isolation, non-git workspace.
- Private input in error text, unwritable receipt destination, bounded output.

A mocked model choice is acceptable for exercising deterministic error paths. It
cannot replace the live Jev integration or establish whether its choices are good.

## Work log convention

Once implementation begins, append milestone/contract, changes, exact commands,
observed outcomes, provenance/version discoveries, unresolved issues and next step.
Keep secrets and private task payloads out. Do not populate the log with invented
execution history or duplicate this plan's current-status table.
