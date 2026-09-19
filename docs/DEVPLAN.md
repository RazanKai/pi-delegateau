# pi-delegateau — Standalone Development Plan

## Authority and starting point

Implement the replacement `SPEC.md`: a standalone Pi extension that can decide
whether a task stays local or is delegated, selects a model for delegated work,
and optionally enforces parent delegation.
Selectively adapt pi-foreman patterns; do not fork its workflow or ship it as a
runtime dependency.

This plan replaces the previous development plan in full. The acceptance table
below is updated as implementation evidence is produced. `WORKLOG.md` is the
chronological record of actual development.

The dispatch scope is intentionally bounded: a configured instance-local slot
pool and finite FIFO queue support compatible single and batch calls. Chains,
nested delegation, worktree management, automatic gates, validator, planner, and
repair loops remain excluded. Child extensions are per-agent, explicit, and
fail-closed.

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
3. Acquire a dispatch slot before selection; M8 supplies bounded parallel slots and
   FIFO waiting instead of rejecting ordinary overlap as busy.
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
- Concurrent tool calls prove the configured admission bound; excess work waits in
  FIFO order and later starts after confirmed cleanup. A cleanup failure blocks its
  own slot rather than falsely returning idle.
- Provider error with zero process exit is not marked successful. A normal exit
  is described as execution completion, not automatically verified correctness.
- Cancellation/timeout probes exercise children with descendants, pre-cancelled
  invocations and startup failure; no owned process remains after success claims.

**Acceptance targets:** T02, T03, T04, T08, T11; child/lifecycle portions of T09 and
receipt portions of T10. Keep cross-milestone contracts PARTIAL until complete.

## M2 — Jev chooses the child model (existing feature)

**Goal:** complete and verify launch-time model selection without folding the new
parent delegation gate into an already implemented feature milestone.

Work:

1. Maintain compact candidate profiles with exact IDs, provenance, capabilities
   and known/unknown cost information.
2. Build one bounded Choice over eligible child candidates from the resolved
   assignment. Keep trusted policy distinct from untrusted task/context data.
3. Skip child-model sensing for pins, fixed mode, a single eligible candidate or
   prohibited disclosure. Reject empty eligibility before launch.
4. Enforce the total selection deadline, response validation and eligible-default
   fallback for sensor failure only. Cancellation never invokes fallback.
5. Revalidate eligibility immediately before launch; reject late sensor results
   after cancellation and preserve admission/cleanup behavior.
6. Show missing credentials and actual fallback distinctly from working Jev
   selection. Record safe metadata, sensing overhead and applied identity.

Exit evidence:

- A live Jev model Choice goes through the registered delegation tool to a real
  child request with matching applied provider/model.
- Controlled HTTP/entry-path cases cover invalid IDs, malformed output, timeout,
  service error, eligibility changes, invalid default and cancellation.
- Pin/fixed/single-candidate paths make no child-model-selection request. They do
  not preclude a separately configured delegation-gate request in M5/M6.
  Disclosure-prohibited paths make neither kind of external sensing request.
- No late launch, admission leak, parent-model change or child-model switch occurs.
- Default receipts omit private payload and secret sentinels, including error paths.

**Acceptance targets:** T05, T06; complete existing T04, T09 and T10 matrices.
Live evidence remains required. New delegation decisions belong to M5/M6, not M2.

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
5. Keep child tool policy independent. No spawn quotas, hidden per-turn classifier,
   plan injection, automatic verifier, or fallback to unrestricted parent execution.
   The later request-scoped gate in M5/M6/R11 is a separate policy layer. Preserve
   this user mode as the base allowlist; never toggle modes to apply a Jev result.
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

1. Document supported versions, configuration, profile/pin semantics, delegation
   decision policies, modes, trust/credential handling, external data exposure,
   receipt location, limits, cancellation guarantees and uninstall/deactivation.
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

**Acceptance target:** T12, followed by a review of the original T01–T12 scope.
New gate milestones and their contracts are evaluated separately below.

## M5 — Request-scoped advisory delegation gate (new feature)

**Goal:** test whether comparative delegation advice is useful before enforcing it.

Prerequisite: complete the live chooser-to-child and verified delegated-task
checks T05/T11 before implementing the new gate. Resolve the admission and
cancellation defects discovered by those runs rather than building over them.
M0–M4 implementation/evidence is not reset by this extension to the plan.

Work:

1. Verify a real awaited Pi request/steering boundary. Record precisely what
   constitutes an accepted request, material steering and settlement. Do not use
   a fire-and-forget subscriber as a barrier or reclassify each turn/tool call.
2. Add manual and advisory policies only, defaulting to manual. Allocate a request
   decision ID/generation independently of child dispatch admission.
3. Build bounded comparative state: task, parent model/capabilities, usable child
   alternatives, relevant parent-context indicator/summary, handoff/isolation
   considerations and preference. Mark unknowns; do not introduce repository
   scraping, full-transcript sensing or another summarizer/classifier.
4. Resolve hard availability/mode constraints in code before sensing. Skip
   redundant policy-determined decisions; never recommend an unavailable path.
5. Show one advisory Choice result as current request context without changing
   tools, rewriting history or rebuilding a changing system prompt. Hold it
   across child returns and ordinary continuation.
6. On sensor failure visibly resume manual behavior; cancellation instead ends
   the decision. Expire decisions on settlement/session replacement or material
   steering. Late responses must be generation-checked.
7. Add independent decision receipts for local, delegated, mixed, blocked,
   cancelled and no-execution outcomes. Link child IDs; distinguish parent
   disagreement, explicit user override and unobserved/no-execution outcomes.
8. Compare manual versus advisory runs with child-model selection held constant;
   include parent, child, gate and chooser overhead. Keep this a small pilot, not
   a new evaluation service.

Exit evidence:

- Live Jev advice reaches a real parent run; the parent can accept or disagree
  without changing its tools. Manual mode makes no delegation-gate request.
- A delayed-handler probe proves the next operation waits for decision/timeout;
  property changes alone do not prove ordering.
- Repeated tool calls and multiple sequential child dispatches under one request
  do not trigger another delegation judgment or consume an extra child lease.
- Material steering/new requests invalidate old answers, child returns do not,
  and settling a request does not leak decision state into the next run.
- Timeout/invalid response visibly returns to manual; cancellation or override
  cannot produce fallback execution or a stale recommendation.
- Local-only, clarification-only and cancelled runs create safe decision records
  without fake dispatch IDs. Child records link to their request decision.
- Comparative state, disclosure prohibition and receipt redaction are exercised
  through the real entry path, not only pure selector calls.

**Acceptance targets:** T13; advisory portions of T15/T17. New contracts remain
PARTIAL until enforced-path clauses are also proven. Report advisory usefulness
separately from model-choice quality; do not automatically proceed on a poor pilot.

## M6 — Request-scoped enforcement and user recovery (new feature)

**Goal:** apply the proven gate as a restriction, never as a permission grant.

Prerequisites: T05/T11 live checks, M5 live advisory check, and verified existing
T03/T07/T09 admission, tool-guard and cancellation/shutdown contracts. Resolve
missing evidence explicitly; no promotion to enforcement on green mocks alone.

Work:

1. Add `jev-enforce` as a separate request policy. Build one effective-policy
   resolver from base-mode permission intersected with gate allowance. Use it
   for both active tool presentation and the actual tool-call guard.
2. Keep the user's mode stable. `local` adds no authority or delegation ban;
   `delegate` removes direct execution. Policy-determined delegation skips Jev.
3. Define pending/failed behavior by tool capabilities: block protected execution
   and child launch but retain permitted conversation, status and recovery. Do
   not ask another model whether this is an 'execution task'.
4. Support visible current-request local/delegate/manual overrides within the
   base policy. Override cancels sensing and invalidates its generation at a safe
   boundary; forbidden capabilities need an explicit base-mode change instead.
5. Test disclosure-disabled behavior, unavailable children, expired decisions,
   late service responses and session replacement. Do not silently become manual
   in enforce mode or carry a failed restriction into a later request.
6. Extend request receipts with effective restriction, policy resolution and
   explicit override events. Preserve no-execution and mixed outcomes honestly.
7. Run manual/advisory/enforced comparisons with child selection held constant.
   Count all inference overhead and verify actual outputs; record failures and
   any evidence that enforcement worsens quality or latency.

Exit evidence:

- Cross the three base modes with local/delegate outcomes and sensor failure;
  effective tools are always a subset of base permission, including dynamic tools.
- Enforced delegate blocks actual direct execution while allowed child launch
  works; local never restores bash/edit/read forbidden by the base mode.
- Missing child availability and policy-forced delegation are handled without a
  pointless Jev request or an impossible allowed path.
- Decision failure preserves status/clarification/user recovery but permits no
  protected execution. Cancellation never doubles as a manual override.
- Override-before-response and steering-before-response races leave the newer
  policy intact. Override expires with its request and cannot widen base tools.
- Delayed decision, multiple child returns, settlement, session change and next
  request tests prove both awaited ordering and no stale restriction leakage.
- Real parent-run traces verify decision receipts for blocked/local/mixed/no-op
  outcomes, linked child dispatches and total gate/chooser usage when available.

**Acceptance targets:** T14, T16; complete T15/T17 and rerun T07/T09/T10.
Full release review covers T01–T17; original evidence remains valid only where the
new policy path has not changed the behavior it established.

## M7 — Selective child extensions

**Goal:** let each trusted agent opt into named extension tools without restoring
child extension discovery or recursive delegation.

Work:

1. Add `childExtensions` to trusted-agent configuration. Missing and empty arrays
   must produce the exact built-in-only launch shape used before this milestone.
2. Resolve names from the effective global and trusted-project Pi `packages`
   settings. Implement Pi npm/git/local package locations and project-over-global
   identity precedence; read `pi.extensions` from manifests rather than guessing
   an entry filename. Resolve `~` and absolute selectors explicitly.
3. Reject missing, ambiguous, undeclared, malformed or non-file entries before
   spawn. Reject pi-delegateau by package/root/entry identity even through aliases
   or paths. Preserve `--no-extensions` and add explicit absolute `-e` entries only.
4. Discover extension tool ownership through an isolated, bounded Pi registration
   probe and validate each configured child tool against built-ins plus tools from
   the resolved entries. Always reject `delegate_task`; do not widen approval of
   command or mutation tools.
5. Add hermetic manifest/layout fixtures for npm, git and local packages, settings
   precedence, TypeScript and JavaScript entries, missing paths, missing manifests,
   absent `pi.extensions`, recursion aliases, unknown tools and no-allowlist argv.
6. Run live children that report their active tools with pi-lens admitted and with
   no allowlist; record an unresolved-name launch failure through the real tool.

Exit evidence:

- A real Pi child launched with `--no-extensions -e <resolved-entry> --tools ...`
  reports the selected extension tool, and its entry matches the installed
  package's manifest rather than a conventional filename.
- The same agent with absent/empty `childExtensions` receives no `-e` arguments
  and reports built-ins only.
- Unknown name, missing path, package without `pi.extensions`, unknown extension
  tool, and every pi-delegateau selector form fail before child execution with a
  clear per-dispatch launch error.
- Existing `bash`/`edit`/`write` behavior is unchanged and no child can call
  `delegate_task`.

**Acceptance target:** T18; rerun T02, T08, T09 and T11 because the launch line and
pre-launch validation change.

## M8 — Parallel queue and batch dispatch

**Goal:** overlap independent children up to a finite limit and queue the rest
without weakening cleanup truthfulness.

Work:

1. Replace `DispatchAdmission` with an instance-local slot pool configured by
   `concurrency` (default 3) and `maxQueueDepth`. Give every queue entry explicit
   queued/running/cancelled/settled state and one idempotent settlement owner.
2. Drain in FIFO order, report one-based queue positions on enqueue and after
   earlier removals, and use explicit gates in tests. Reject queue overflow before
   model sensing. Remove and wake queued cancellations without assigning a slot;
   recheck cancellation at dequeue/start boundaries.
3. Carry the acquired slot through selection, launch and process cleanup. A running
   abort only signals the child. The single settle operation releases a verified
   slot or converts its same slot to blocked/degraded; healthy slots continue.
4. Extend status with capacity, occupied/running, queued and blocked counts plus
   sanitized blocked reasons. Shutdown drains queued calls and aborts running calls
   without double release or late start.
5. Add a mutually exclusive `assignments` batch schema while preserving the legacy
   single schema. Validate whole-call capacity, dispatch each element independently,
   preserve input-order results, and write a receipt per dispatch even when siblings
   fail or cancellation interrupts the batch.
6. Add deterministic pool, FIFO, queue-position, overflow, queued-abort,
   dequeue/abort race, startup-failure, blocked-slot and batch tests. Then run real
   provider children with a low limit and capture timestamps proving overlap and a
   queued third assignment with position updates.

Exit evidence:

- At `concurrency=2`, two synchronization-controlled children run together and a
  third starts only after the first verified settlement; queue updates report its
  changing one-based position and no call receives the former busy result.
- Cancelling queued work never invokes selection/spawn, never leaks capacity and
  never starts after a later release. Cancelling running work settles exactly once.
- One unverified process group leaves one blocked slot visible while remaining
  capacity continues; a fully blocked pool queues or rejects only according to the
  configured depth and never falsely reports idle.
- Legacy single calls and mixed-outcome batches produce separate IDs/receipts;
  batch output preserves input order and truthful per-element statuses.
- Live provider timestamps prove actual wall-time overlap and FIFO queueing through
  the registered extension path, not a mocked pool.

**Acceptance targets:** T19, T20; rerun T03, T09, T10 and T17 under concurrency.

## Acceptance coverage — authoritative status

Statuses: TODO = not implemented/proven; PARTIAL = named subset verified; DONE =
all clauses verified with concrete test/run evidence. Add actual file/symbol/test
or artifact references when updating. Milestone ownership is not evidence.

| Contract | Requirements | Owner milestones | Status | Evidence / remaining work |
| --- | --- | --- | --- | --- |
| T01 | R01 | M0, M4 | PARTIAL | `package.json`, `src/index.ts`, `NOTICE.md`, and `THIRD_PARTY_LICENSES/pi-foreman-MIT.txt` provide a standalone package and attribution; `PI_OFFLINE=1 ./node_modules/.bin/pi -e ./src/index.ts --list-models` exits 0 without pi-foreman, and a packed tarball installs into a clean `/tmp` consumer with Pi peer metadata. Production Pi installation remains unperformed. Duplicate-tool rejection is documented as a Pi 0.85.1 limitation (no load-time seam); runtime shadow detection added. |
| T02 | R02, R07 | M1, M3 | PARTIAL | `src/index.ts` registers `delegate_task`; `src/runner.ts` normalizes provider errors, requested/served/applied model evidence, and statuses; failures surface via the error channel (verified through the real agent loop); `tests/pi-process.test.ts` exercises a real spawned JSON child. A live configured provider dispatch remains. |
| T03 | R02, R08, R13 | M1, M2, M8 | DONE | `tests/admission.test.ts` proves bounded acquisition, FIFO promotion, idempotent settlement and per-slot blocking; `src/dispatch.ts` holds the lease through selection/run/cleanup and degrades it on unverified process cleanup. `tests/extension-entry.test.ts` exercises the registered batch path with real subprocess overlap and later admission. |
| T04 | R03, R05 | M1, M2 | PARTIAL | `tests/selection.test.ts` covers pin/fixed/single/empty/fallback/cancel precedence; `src/index.ts` revalidates Pi registry/auth eligibility and shares `resolveLaunchModel` with the gate. Full live registry matrix remains. |
| T05 | R04, R07 | M2 | PARTIAL | `src/jev.ts` and `src/gate.ts` use the verified TypeSafe SDK `0.6.0` Choice shape. A credentialed live `JevDelegationSelector` call returned a valid recommendation on 2026-09-19; no credentialed Jev-to-provider-backed-child run was possible because local Pi reported no configured models. |
| T06 | R03, R05 | M2 | PARTIAL | Selector tests cover sensor failure, invalid choice fallback, and cancellation; entry point revalidates after selection. Gate tests additionally cover invalid delegation recommendations, bounded failure, cancellation, and late answers. Controlled HTTP and late-response entry-path probes remain. |
| T07 | R06 | M3 | PARTIAL | `src/mode.ts`, `src/index.ts`, and `tests/extension.test.ts` cover explicit active-tool selection and call-time blocking, including unknown tools. `tests/gate.test.ts` proves request restrictions intersect rather than widen the base surface. `tests/config.test.ts` proves configured allowlists cannot re-admit mutation tools. Real Pi dynamic-tool bypass probes remain. |
| T08 | R02, R07 | M1, M3 | PARTIAL | `src/pi-process.ts` uses `--no-session`, `--no-extensions`, explicit model/tools/thinking, and assignment-only prompt data; `tests/pi-process.test.ts` verifies real JSON launch flags, model evidence, and trusted-prompt/task separation. Untrusted-project delegation is refused before config reads (`ctx.isProjectTrusted` gate, probe-verified). A live provider-backed sentinel-isolation child run remains. |
| T09 | R05, R08 | M1, M2 | PARTIAL | `src/runner.ts` handles pre-cancel, wall-time, turn limit, signal propagation, usage, and observed close; `tests/pi-process.test.ts` proves group sweeps on timeout, NORMAL EXIT, and cancellation with SIGTERM-ignoring descendants (readiness-driven, /proc-verified). `session_shutdown` aborts owned dispatches, but shutdown and cleanup-failure entry-path probes remain. |
| T10 | R09 | M1, M2 | PARTIAL | `src/receipts.ts` now makes decision `reason`, `invalidationReason`, and dispatch `fallbackCause` category-typed and classifies them unconditionally inside the receipt builders; `tests/receipts.test.ts` behaviorally proves remote prompt/body text is absent from all three fields. `tests/extension-entry.test.ts` verifies linked decision/dispatch receipts; Jev is skipped when prohibited. Full entry-path disclosure and unwritable-destination probes remain. |
| T11 | R01, R07, R10 | M1, M3 | PARTIAL | `tests/extension-entry.test.ts` runs the real registered `delegate_task` path with a disposable non-git temporary workspace and a real executable child fixture, checking launch, output, applied-model evidence, and linked receipts. A real provider-backed delegated task remains unavailable because Pi reports no configured models. |
| T12 | R09, R10 | M4 | TODO | No fixed-versus-Jev quality/latency pilot has been run. The remaining work requires a configured provider-backed child and a paired live workload; no mock result is being counted as pilot evidence. |
| T13 | R10, R11 | M5 | PARTIAL | `src/gate.ts` implements request-scoped manual/suggest/enforce decisions, and `src/index.ts` wires the gate into `before_agent_start`, system-prompt guidance, overrides, settlement, and steering (steering now regenerates the decision). `tests/gate.test.ts` covers advisory behavior, failure, cancellation, generation, fast-path invalidation without orphaned rejections, and late-answer isolation; live Pi parent-path evidence remains. |
| T14 | R06, R09, R11 | M6 | PARTIAL | `ModeController.setRequestRestriction` and `guard` enforce base-policy intersection for delegate/blocked states; gate tests cover no widening and protected failure; hard base-mode policy resolves before the disclosure check (offline enforced modes verified). Real Pi alternate/dynamic-tool bypass and full unavailable-path entry probes remain. |
| T15 | R06, R08, R11 | M5, M6 | PARTIAL | `DelegationGate` tracks generations, awaits bounded decisions, invalidates steering/session replacement, ignores late answers, and does not reuse decisions across changed policies with identical prompts; deterministic tests cover cancellation and generation replacement. A real Pi continuation/settlement ordering probe remains. |
| T16 | R06, R08, R11 | M6 | PARTIAL | Enforced Jev failure, sensing-prohibited, missing-credential, and malformed-config paths fail closed (constructor throws eliminated; hook failures still install restrictions — real-ExtensionRunner probes verify). Explicit current-request overrides preserve the base policy and override late answers. Full enforced entry-path recovery and override probes remain. |
| T17 | R09, R11 | M5, M6, M8 | PARTIAL | Independent decision receipts and dispatch receipts are implemented, with `decisionId` links captured at admission and observed execution outcomes; `delegated` is only claimed after a child process starts (real-dist probe verification). No-execution, blocked, mixed-outcome, and parallel-batch entry-path coverage remains. |
| T18 | R07, R08, R12 | M7 | DONE | `src/child-extensions.ts` uses Pi 0.85.1 `SettingsManager`/`DefaultPackageManager` resolution, verifies owning manifests/entries, rejects pi-delegateau, and validates runtime tool provenance from the isolated probe in `src/pi-process.ts`. `tests/child-extensions.test.ts`, `tests/config.test.ts`, and `tests/pi-process.test.ts` cover package precedence, explicit failures, no-allowlist argv and tool ownership. Live registered-tool runs report `read, lens_diagnostics` with pi-lens and `read, grep` without an allowlist; an unknown package is a launch error. |
| T19 | R02, R08, R13 | M8 | DONE | `src/admission.ts` implements the finite pool/FIFO queue and one idempotent settlement point; status reports running/blocked/queued capacity. Deterministic admission tests cover position changes, overflow, queued cancellation, double settlement and degraded slots. A live registered batch at concurrency 2 reported the third dispatch at queue position 1, two running timestamps before either settled, and promotion only after settlement. |
| T20 | R07, R09, R13 | M8 | DONE | `src/index.ts` preserves the single form and adds mutually exclusive `assignments`; `src/dispatch.ts` gives each element an independent ID, lifecycle and receipt. `tests/extension-entry.test.ts` proves ordered three-element success plus ordered mixed success/failure with five independent receipts; the live batch returned three distinct successful IDs in input order. |

## Minimum failure matrix

Cover these through the actual extension entry points, with deterministic fixtures
where appropriate:

- Invalid configuration, unavailable credentials, missing or ineligible pin.
- Empty/one/multiple candidate sets, unknown profile metadata, default unavailable.
- Sensor disabled, remote error, invalid selected ID, slow response, late response.
- Delegation gate manual/suggest/enforce, bounded parent-versus-child state,
  unavailable child alternatives, policy-determined bypass and unknown metadata.
- All base-mode/local/delegate/failure combinations; no permission widening,
  disclosure-prohibited sensing, or alternate/dynamic-tool bypass.
- Multiple tool calls/child returns within one request; new request, material
  steering, settlement and session replacement invalidate the correct generation.
- Delayed awaited decision, cancellation/override before response, sensor failure,
  visible manual advisory fallback and protected enforced failure with recovery.
- Independent local/blocked/clarification/cancelled/mixed receipts, correct child
  linkage and no false acceptance/override labels for unobserved behavior.
- Concurrent dispatch attempts, FIFO queue ordering/position updates, queue overflow,
  queued cancellation/dequeue races, blocked individual slots and failure during
  each lifecycle stage.
- Legacy single input, empty/mixed/oversized batches, sibling failure/cancellation,
  independent batch receipts and input-order aggregation.
- Child spawn error, provider error despite zero exit, signal exit, hanging child,
  descendant process, wall-time/turn limit, cleanup failure and session shutdown.
- Prohibited static/dynamic tools, alternate launch tools, mode change while busy.
- Child extension loading by npm/git/local manifest and explicit path, settings
  precedence, missing/ambiguous entries, tool ownership, recursion rejection,
  absent/empty allowlist, transcript sentinel isolation, non-git workspace.
- Private input in error text, unwritable receipt destination, bounded output.

A mocked model choice is acceptable for exercising deterministic error paths. It
cannot replace the live Jev integration or establish whether its choices are good.

## Work log convention

Once implementation begins, append milestone/contract, changes, exact commands,
observed outcomes, provenance/version discoveries, unresolved issues and next step.
Keep secrets and private task payloads out. Do not populate the log with invented
execution history or duplicate this plan's current-status table.
