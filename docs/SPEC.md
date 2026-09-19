# pi-delegateau — Standalone Product Specification

> Delegate the work. Match the model. Every agent gets a slice.

## 1. Decision and scope

Build a standalone Pi extension with selective reuse of `rodh/pi-foreman` and
Pi's official subagent example. This is not a pi-foreman fork, wrapper requiring
pi-foreman to be installed, or new agent runtime.

The product has three independent responsibilities:

1. Optionally decide whether an upcoming task should stay with the parent or be
   delegated, using a bounded Jev decision.
2. Choose a model once for each delegated assignment, using TypeSafe's Jev or a
   fixed policy.
3. Optionally enforce delegation by restricting the parent's execution tools.

By default, the parent understands and decomposes the task and makes the
local-versus-delegated choice itself. The optional Jev gate can recommend or
enforce that choice. Code validates, launches, cancels, and reports. The child
does the assigned work on one fixed model. The parent integrates the result and
decides what to do next.

**Status:** product specification; implementation and runtime evidence are tracked
in `DEVPLAN.md` and `WORKLOG.md`. This document replaces the previous
specification in full.

### V1 scope

- One model-facing delegation tool, one assignment per invocation.
- One active dispatch per parent extension instance, enforced in code.
- Jev selection or fixed selection; explicit eligible default and optional pins.
- Optional Jev local-versus-delegated decision: manual, advisory, or enforced.
- Normal, delegate-execution, and coordinator-only parent modes.
- Isolated child context, streamed progress, bounded results, cancellation.
- Small local routing receipts and a fixed-versus-Jev evaluation.

Sequential dispatch is an intentional simplification: there is no batch schema,
work queue, parallel reader/writer scheduler, or worktree manager in v1.

### Explicit non-goals

- Mandatory `PLAN.md`, a plan-writing tool, or per-turn plan reinjection.
- Automatic shell gates, remediation loops, test-first enforcement, or validators.
- Mandatory git repository, clean working tree, commits, or HEAD-based review.
- Runtime repo-map generation or a repo-map cache.
- Child model switching, adaptive thinking, learning, utility optimization, or
  global budgets/work graphs.
- Jev generating subtasks, granting permissions, or operating tools.
- Nested delegation, parallel batches, chains, or an automatic retry on another
  model after a child starts.
- An OS security sandbox, protection against malicious installed extensions, or
  global interception of third-party subagent launchers in normal mode.
- Pi core patches, production installation, or changes to Hermes.

The parent may explicitly delegate testing or review like any other assignment.
That does not introduce an automatic verification pipeline.

## 2. Selective reuse, not workflow inheritance

### Source baseline

pi-foreman was inspected at:

`e19a9ad9dce5c304e451e095e5899ddab00b3027`

Repository: https://github.com/rodh/pi-foreman

GitHub identifies this revision's project as MIT-licensed. Before copying code,
read the exact LICENSE, preserve required copyright/license notices, and document
source revision and adapted portions in the new package. There is no requirement
to copy code when a supported Pi API is simpler.

| Source element | Treatment | Product boundary |
| --- | --- | --- |
| `index.ts`: mode toggle, save/restore active tools | Adapt the small pattern | Add stable policy and a call-time guard; no planning workflow |
| `index.ts`: self-contained task dispatch | Adapt the pattern | Generic agent/task dispatch, not implementer/validator roles |
| `runPi.ts`: fresh process and JSON event consumption | Reference, then compare with current Pi example | Reuse only after lifecycle and protocol tests; do not copy wholesale |
| `config.ts`: explicit child tools and model fields | Reuse the idea | Validated user configuration and exact model identities, not source-code edits |
| `PLAN.md`, `update_plan`, prompt reinjection | Exclude | Parent planning remains ordinary Pi behavior |
| `gates.ts`, automatic repair, validator branch | Exclude | No implicit extra inference or command execution |
| `git.ts`, `repomap.ts` | Exclude | No git baseline assumption or hidden repository ingestion |

Pi's official subagent example remains the reference for current process/event
behavior and compatibility. Select one launch implementation; do not vendor two
runners or introduce a generic runner plugin system. Pin the Pi version used for
implementation and verify its real extension contracts before choosing imports.

### Source-review cautions

These are findings from reading the pinned pi-foreman source, not reproduced
runtime bugs or claims about later revisions:

- Sequential dispatch is requested in a prompt, without a dispatch mutex.
- `proc.killed` is used to decide kill escalation; that flag indicates a signal
  was sent, not that the child has exited. Direct-child signaling is not proof of
  descendant cleanup.
- An unparseable validator is described as failure but is absent from the final
  task-failure expression.
- Review diffs are against HEAD, not a per-assignment baseline.
- Malformed gates are skipped with a passing flag; red-test mode treats arbitrary
  command failures as expected failure.

Only the first two concerns belong in this product's execution layer. The other
subsystems are not imported and should not be rebuilt merely to fix them.

## 3. User surface

### Parent tool: `delegate_task` (proposed name)

Inputs:

- `agent`: a configured trusted agent definition, providing instructions and tools.
- `task`: self-contained assignment.
- `expectedOutput`: optional acceptance/output description.
- `context`: optional bounded context supplied by the parent.

No model name, child model preference, or self-assessed complexity number is
required from the parent. The parent describes work, not resource allocation.
Reject duplicate tool-name registration rather than silently overriding another
extension. Freeze the final tool name during the compatibility milestone.

### User configuration

- Selection: `fixed` or `jev` for choosing the child model.
- Delegation decision: `manual`, `jev-suggest`, or `jev-enforce`.
- Delegation: `normal`, `delegate-execution`, or `coordinator-only`.
- Routing preference: `economy`, `balanced`, or `quality`.
- Candidate profiles, exact default model, optional trusted agent model pins.
- Provider/disclosure restrictions and approved parent/child tools.
- Selection deadline, child execution limits, and output limits.

Exact configuration path, command syntax, and supported SDK types are determined
against the pinned Pi release, not invented in this specification. Provide a
status command and explicit mode/enable/disable controls. Do not require editing
TypeScript source to configure models.

Installation leaves the parent in normal mode. Enforced modes require explicit
user activation at an idle boundary. Recommend delegate-execution for the first
trial. Jev use requires explicit external-disclosure consent and configuration;
missing credentials must be visible, not disguised as successful routing.

`manual` leaves the local-versus-delegated decision to the parent model, as in
basic Pi. `jev-suggest` asks Jev for one bounded `delegate` or `local`
recommendation before the parent acts; the parent may override it. The
recommendation and confidence are visible, and Jev failure falls back to manual
behavior with a visible warning. `jev-enforce` uses the same decision to control
whether direct execution tools or delegation tools are available. It fails
closed for an execution task if Jev is unavailable, invalid, or cancelled;
explicit user override remains available. Neither mode lets Jev invent
subtasks, grant permissions, or choose outside the configured model/tool
policies.

## 4. Requirements

### R01 — Standalone package and deliberate reuse

Ship one independently installable TypeScript Pi extension with its own entry
point, configuration, tests, and documentation. Do not require pi-foreman at
runtime. Record the provenance and license of adapted source. Use supported Pi
APIs, not defensive guessing of argument positions across unknown versions.
If the required seam does not exist, report the blocker before changing scope.

### R02 — Bounded sequential dispatch

Resolve the agent and task and acquire an in-memory dispatch admission lock before
any sensing or child launch. A second invocation receives a clear busy result;
there is no queue. Hold the lock through selection, execution, and cleanup and
release it on success, failure, cancellation, and startup errors.

The lock covers this parent extension instance only. It does not coordinate other
Pi sessions or user processes; document that limitation. Do not claim a global
single-writer guarantee. Children cannot invoke this or another delegation tool
through their enabled toolset. No automatic recursive launch capability is loaded.

### R03 — Eligibility, profiles, and precedence

Resolve exact provider/model identities against Pi's configured model registry and
available authentication. Filter by the user's allowlist, provider/privacy rules,
child tool support, and known context/capability requirements. Unknown constraints
must not be represented as verified support. Authentication is not uptime.

A profile includes identity, supplied capability/limitation description, provenance,
and cost/latency data when known. User-authored profiles are provisional. Missing
price is unknown, not free; subscription quota is not unlimited capacity. Newly
discovered models do not enter the pool automatically.

Apply this selection order:

1. A trusted agent pin: validate eligibility, use it, or fail; never override it.
2. Fixed mode or prohibited external sensing: use the configured eligible default
   or fail. Do not call Jev.
3. Jev mode with zero candidates: fail before launch.
4. Jev mode with one candidate: use it without sensing.
5. Jev mode with multiple candidates: request one Choice judgment.

A fallback default is not a pin. Do not silently inherit the parent's model or
choose an arbitrary catalog entry. Revalidate launch eligibility after selection.

### R04 — One Jev model-selection judgment per delegated assignment

When child-model selection is enabled, ask one Choice question over the eligible
candidate IDs. A separate R11 delegation decision may happen before this; it is
not a second model-selection request.

> Which eligible model best fits this assignment under the supplied routing
> preference and candidate profiles?

State contains the actual task, trusted agent instructions, allowed child tools,
optional expected output/context, profiles, and preference. Code controls the
candidate list. Treat task/context as data, not authorization or new routing
instructions. Separate those inputs from trusted policy.

Do not read repository files or transmit the full parent transcript to improve the
choice. Bound input size; reject oversized required input and explicitly bound
optional context. Never silently truncate constraints or task requirements.

Validate the selection and returned structure against that request's candidates.
Keep probability/confidence for inspection, not as a calibrated success guarantee.
A valid uncertain answer is still used in v1; no arbitrary confidence threshold or
second explanation call. Jev does not set tools, thinking level, or child budgets.

### R05 — Safe default behavior

Bound the entire sensing operation, including any transport retry, by a configured
deadline. A timeout, invalid response, or sensor service failure may select only
the configured default if it is still eligible; otherwise return a launch error.
Display fallback explicitly and preserve its cause.

Cancellation never triggers fallback. Provider execution failure after launch is
a child failure, not a reason for another model invocation. The parent may submit
a new assignment, but this extension does not create repair/retry loops.

### R06 — Parent delegation policy

Modes:

| Mode | Parent capabilities |
| --- | --- |
| `normal` | Existing tools plus delegation guidance; no enforcement |
| `delegate-execution` | Delegation, approved read/search and coordination tools; no direct commands or mutation |
| `coordinator-only` | Delegation and approved coordination/user interaction; no direct repository tools |

Use explicit allowlists in enforced modes. Blocking only edit/write is inadequate
if bash, interpreters, external tools, or alternate launchers remain. Unknown or
newly registered tools are not automatically admitted. Apply tool selection before
inference and enforce the same decision at the actual tool-call boundary.

Keep stable delegation instructions while a mode is active. Do not inject a
changing plan into the system prompt. Change modes only by explicit idle-boundary
user action, restore the captured prior tool selection on deactivation, and
account for tools removed since activation. Do not silently weaken a mode when a
Pi version cannot enforce it.

Never require a minimum number of child invocations. Conceptual answers need no
ceremonial delegation. This is a tool-execution boundary, not proof of good task
decomposition or a sandbox against hostile installed code.

### R11 — Optional Jev delegation decision

Support an explicit decision policy separate from child-model selection:

- `manual`: do not call Jev; the parent decides whether to use `delegate_task`.
- `jev-suggest`: ask one bounded Jev Choice for `delegate` or `local` before the
  parent acts. Show the recommendation and confidence to the parent, but permit
  the parent to override it. A Jev failure visibly returns control to the manual
  path.
- `jev-enforce`: use the same decision to select the parent tool surface. A
  `delegate` result blocks direct execution tools and leaves delegation available;
  a `local` result leaves direct execution available and does not require a
  child. An unavailable, invalid, or cancelled decision fails closed for an
  execution task rather than silently becoming manual. A user override must be
  explicit and visible.

The gate receives the current task and bounded policy/context data, not the full
parent transcript or repository contents. It cannot create subtasks, select
permissions, override mode allowlists, or choose a child model. The child-model
selection remains a separate decision after the parent calls `delegate_task`.
Cancellation never falls back to either recommendation. Record whether the
recommendation was accepted or overridden, its latency, and its safe outcome in
the receipt without storing the task body or raw service response.

### R07 — Child execution and truthful result contract

Launch with explicit provider/model, fixed supported thinking configuration,
trusted child instructions, child tools, and working directory. Do not change the
parent model or let selection expand permissions. Isolate child conversation state;
Pi's documented project instructions may still apply and must be distinguished
from parent transcript inheritance. Project-local agents require trust approval.

Control child extension/tool loading to prevent recursive delegation. Do not
assume a built-in tool flag also disables tools from loaded extensions; verify
that behavior on the pinned Pi version.

Preserve useful streaming, bounded output, diagnostics, and available usage.
Confirm the applied model through child runtime/provider evidence, not only the
requested launch arguments. Model substitution must not be hidden.

Return dispatch ID, agent, selected/applied model, selection source, terminal
status, final child output, and available usage/error metadata. Distinguish at
least success, failed, cancelled, timed-out, and launch-error. A zero process exit
alone is insufficient: account for reported provider/assistant errors and aborts.
'Success' means execution completed without such errors, not independently
verified task correctness. Child claims remain claims; the parent owns acceptance.

No required fenced JSON summary, validator verdict, gates, or automatic git diff.

### R08 — Cancellation, limits, and cleanup

Propagate cancellation through admission, pending sensing, and child execution.
An already-cancelled call must not spawn. A late sensing response cannot start a
child after cancellation. Use explicit lifecycle state to reject late events.

Configure finite child wall-time/turn limits and bounded returned output. Reaching
a limit yields a distinct failure reason, not successful completion. On shutdown
or cancellation terminate owned processes, wait for observed exit, then escalate
if needed. Never equate 'signal sent' with 'process exited'. Verify descendant
cleanup on each claimed supported platform; Linux is the initial target.

Clean up temporary files, listeners, and timers on all terminal paths, including
spawn errors. If termination cannot be confirmed, retain a visible blocked/busy
state rather than admitting overlapping work and claiming cancellation succeeded.

### R09 — Privacy, credentials, and receipts

Explain what data goes to Jev and to the child provider separately. Sensing
prohibited means no Jev request. Child provider restrictions still apply to pins,
fixed selection, and fallback. Store secrets only via supported credential
mechanisms; never in prompts, checked-in config, or receipt fields.

Display a small launch receipt: agent, applied provider/model, selection source
(`pin`, `fixed`, `single-candidate`, `jev`, `fallback`), and routing preference.
Keep local structured selection/completion records linked by dispatch ID:

- eligible IDs and profile/config versions;
- selected/applied identity and source;
- delegation-decision policy, recommendation, effective action, and override state;
- bounded selection probabilities/confidence when present;
- delegation-decision latency, model-chooser latency, available chooser/child usage,
  outcome and error category.

Exclude raw prompts, task bodies, repository contents, and secrets from default
receipts. Do not store raw service error bodies without sanitization. Child output
in Pi's normal transcript follows Pi's own storage behavior; receipt redaction
must not be marketed as redacting the whole Pi session. No hidden reasoning logs.
Telemetry failure may warn without blocking otherwise permitted work. Report
unknown costs as unknown; do not invent a textual explanation for Jev's decision.

### R10 — Evidence and useful scope

Test the actual extension dispatch path and hooks, not only internal functions.
Use isolated Pi state and disposable workspaces. Include a non-git workspace to
prove the product has not inherited pi-foreman's HEAD-based dependency.

Run a live Jev-to-child smoke test and a paired fixed-versus-Jev pilot under the
same delegation mode. Include sensing overhead, failures, quality checks, total
latency, and available usage/cost. Evaluate delegation-mode changes separately.
For the Jev delegation gate, test manual, advisory, enforced, override, failure,
and cancellation behavior through the real parent turn path.
Do not claim savings, compatibility, or completion from mock fixtures. A provider
or credential blocker leaves live acceptance incomplete, not silently waived.

## 5. Minimal implementation shape

Use a handful of modules with real consumers, not a scheduler framework:

- Extension entry: tool/commands, mode lifecycle, dispatch admission.
- Configuration/eligibility: profiles, exact identities, pins and hard constraints.
- Delegation gate: optional Jev local-versus-delegated decision and tool-surface
  policy.
- Jev selector: one model Choice request, deadline, validation and eligible fallback.
- Child runner: explicit launch, event normalization, limits, cancellation/cleanup.
- Receipts: local safe metadata and UI reporting.

Conceptual lifecycle:

`idle -> deciding? -> selecting -> running -> cleaning-up -> idle`

Manual dispatches skip the delegation-decision step; fixed and pinned dispatches
skip model sensing. Neither skips eligibility. Errors and cancellation enter
cleanup. A busy response starts no lifecycle of its own. Model selection is not
revisited once a child starts.

## 6. Acceptance contracts

| ID | Contract | Requirements |
| --- | --- | --- |
| T01 | Standalone load, attribution and supported API integration without pi-foreman installed | R01 |
| T02 | Real tool invocation launches explicit-model child; parent model unchanged; execution errors reported accurately | R02, R07 |
| T03 | Simultaneous dispatch attempts admit only one; terminal cleanup permits a later call | R02, R08 |
| T04 | Pins/default/single-candidate/empty-set precedence and eligibility enforced without unnecessary Jev calls | R03, R05 |
| T05 | Live Jev Choice reaches the real child launch and applied model matches the validated selection | R04, R07 |
| T06 | Sensor failures use only eligible fallback; changed eligibility blocks an invalid launch | R03, R05 |
| T07 | Both enforced modes block direct and dynamically registered prohibited tools; normal/deactivated mode works | R06 |
| T08 | Child context/tool isolation prevents parent transcript inheritance and model-facing recursive delegation | R02, R07 |
| T09 | Pre-cancel, sensing cancel, running cancel, limits and shutdown leave no late launch or owned process leak | R05, R08 |
| T10 | No sensing under disclosure prohibition; default receipts omit private payloads and secrets | R09 |
| T11 | Verified delegated task works in a non-git workspace without plans, gates, validator or remediation | R01, R07, R10 |
| T12 | Paired fixed/Jev pilot reports quality and total overhead honestly, with failures and unknown costs | R09, R10 |
| T13 | Optional Jev delegation decision supports manual, suggestion, enforcement, override, failure, and cancellation without bypassing tool policy | R06, R10, R11 |

## 7. Authoritative integration references

- Pinned pi-foreman source:
  https://github.com/rodh/pi-foreman/tree/e19a9ad9dce5c304e451e095e5899ddab00b3027
- Pi extensions:
  https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Pi subagent example:
  https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent
- Pi SDK/model runtime:
  https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- TypeSafe docs: https://docs.typesafe.ai/llms.txt
- TypeSafe Choice: https://docs.typesafe.ai/primitives/choice.md
- TypeSafe JavaScript SDK: https://docs.typesafe.ai/sdk/javascript.md

Unpinned documentation links are discovery references, not compatibility promises.
Implementation must record the actual versions and real test outcomes.
