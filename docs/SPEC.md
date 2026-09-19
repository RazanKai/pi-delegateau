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

- One model-facing delegation tool with compatible single-assignment and bounded batch forms.
- A configured number of active dispatches per parent extension instance, with a bounded FIFO queue.
- Per-agent opt-in child-extension allowlists; absent or empty allowlists preserve built-in-only children.
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
- Nested delegation, chains, worktree scheduling, or an automatic retry on
  another model after a child starts.
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
basic Pi. `jev-suggest` makes one bounded `delegate` or `local` recommendation
per accepted user request/run; the parent may override it without changing tools.
A sensor error visibly returns to manual behavior. Cancellation is not a sensor
error and never triggers fallback.

`jev-enforce` adds a request-scoped restriction within the user's existing tool
policy. `delegate` blocks direct commands/mutation while retaining eligible
delegation and permitted coordination. `local` adds no restriction and does not
require a child; it never restores tools forbidden by the base mode. Sensor
failure blocks protected execution, not conversation, status, clarification or
explicit user override. Neither policy lets Jev create subtasks or grant authority.

Implement advisory routing first. Enforced routing is a later milestone, gated on
live evidence for the existing chooser/child path and the advisory decision path.

## 4. Requirements

### R01 — Standalone package and deliberate reuse

Ship one independently installable TypeScript Pi extension with its own entry
point, configuration, tests, and documentation. Do not require pi-foreman at
runtime. Record the provenance and license of adapted source. Use supported Pi
APIs, not defensive guessing of argument positions across unknown versions.
If the required seam does not exist, report the blocker before changing scope.

### R02 — Bounded dispatch admission

Resolve each agent and assignment and acquire an in-memory dispatch slot before
any sensing or child launch. Hold that slot through selection, execution, and
cleanup and settle it on success, failure, cancellation, and startup errors.
R13 defines the pool, queue, blocked-slot and batch semantics that replace the
original single-dispatch lock; admission remains local to one extension instance.

The pool does not coordinate other Pi sessions or user processes; document that
limitation. Do not claim a global concurrency or single-writer guarantee. Children
cannot invoke this or another delegation tool through their enabled toolset. No
automatic recursive launch capability is loaded.

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

### R11 — Optional request-scoped Jev delegation decision

#### Decision lifetime and input

Make at most one semantic delegation judgment per accepted user request/run, not
per tool call, child return, or child dispatch. Hold the applied decision stable
through that run's continuation and child returns. Give the request a decision ID
and generation before sensing. Completion, cancellation, session replacement or
a material user steering instruction invalidates it. A new accepted task or
material steering instruction starts a new generation at a safe, awaited
boundary before further execution. Old responses cannot affect the new generation.
Treat accepted steering that changes work as material by default; do not add a
second classifier to decide whether to invalidate. Status/coordination commands
do not themselves create new work generations.

The decision compares parent execution with the available delegated alternative:

> Given this parent, the eligible child capabilities, the assignment's context
> requirements, and the user's policy, which permitted execution path is
> preferable after accounting for handoff cost?

Supply bounded state: the task; parent model/profile and permitted capabilities;
a compact eligible-child capability/profile summary; the availability of a usable
child; relevant context already available to the parent as a bounded summary or
explicit indicator; expected output, context-transfer/isolation considerations;
and user routing preference. Mark unknown information as unknown. Do not mistake
task difficulty for delegation value or assume an isolated child has the parent's
context. Parent-supplied context summaries are evidence of limited reliability,
not permission grants. Do not read repository files for the gate or transmit the
full parent transcript. Do not create a memory summarization subsystem for this.

Code performs availability and permission checks first. If the base policy already
requires delegation for execution, skip the redundant judgment and record a
policy-determined outcome. If no usable child exists, recommend local only when
the base policy permits it; otherwise report a blocked execution path. Do not let
Jev select an impossible path. Availability does not guarantee provider uptime;
child eligibility is still revalidated at launch.

#### Decision policies

- `manual`: no delegation-gate request; the parent decides whether to delegate.
  Independently configured child-model selection may still call Jev.
- `jev-suggest`: display the recommendation and confidence as request-scoped
  context, without changing tools or past conversation. The parent may disagree.
  Timeout, invalid response or sensor failure visibly falls back to manual.
  Cancellation ends the decision and does not resume manual execution by fallback.
- `jev-enforce`: apply a request-scoped restriction before execution. `delegate`
  blocks direct commands/mutation; delegation, approved reads and coordination
  remain only where the base policy allows them. `local` adds no restriction:
  parent execution remains possible only to the extent already authorized, and
  delegation remains optional. This is not a prohibition on later delegation.

All sensing has bounded input and a total deadline. External-disclosure policy
applies before either Jev decision. If sensing is prohibited, advisory mode has a
visible manual outcome; enforce mode stays blocked unless code can determine a
permitted outcome from hard policy or the user explicitly overrides it. Never
send data merely to discover whether disclosure is allowed.

#### Policy composition and failure behavior

Compute one effective policy for model-visible tools and the call-time guard:

`effective tools = user/base-mode allowlist intersect request-gate allowance`

The gate may remove capabilities, never add them. In delegate-execution mode a
local decision cannot restore bash/edit/write; in coordinator-only mode it cannot
restore repository tools. Represent the user mode and request decision separately;
do not implement the gate by toggling or replacing the user's mode. Preserve
R06's explicit user-only mode transitions and restoration semantics.

While an enforced decision is pending or failed, block direct execution/mutation
and child launch. Keep permitted conversation, clarification, status and explicit
user recovery available. Do not introduce another semantic 'execution task'
classifier: the fail-closed boundary is defined by tool capability. There is no
requirement to delegate a purely conversational answer.

An explicit user override chooses local, delegate, or manual behavior for the
current request only, remains within the base policy, and is visible. Restoring
otherwise forbidden tools requires a separate explicit base-mode change. Apply
overrides at a safe boundary; cancel pending sensing and invalidate its response
generation. An override never lets a late response reinstate the old restriction.
Cancelling the request cannot be used as an implicit override.

Before another request starts, expire the old decision and recompute from base
policy; restrictions must not leak between requests. Tool/prompt changes occur
only at explicit request, steering or user-override boundaries, not on every turn.
An event notification
alone is not sufficient: verify the chosen hook is awaited before the next model
request/tool execution. Do not rewrite past messages or a changing system plan.

#### Outcomes and child separation

Record recommendation, source (manual, policy-determined, Jev, fallback or user
override), effective restriction and observed outcome. An explicit user override
and a parent choosing differently in advisory mode are distinct events. Only
claim observed agreement/disagreement when an execution path supplies evidence;
clarification, no execution and cancellation are separate outcomes, not assumed
overrides. Mixed local/delegated execution is representable because local does
not prohibit delegation.

The gate has no dispatch admission lease. Existing R02 admission begins when
`delegate_task` is invoked; the gate must not consume the child lease for a local
run. The child model is selected independently after that invocation. Each child
receipt links to its parent decision ID when one exists, and one request can have
multiple sequential dispatches without rerunning the gate.

### R07 — Child execution and truthful result contract

Launch with explicit provider/model, fixed supported thinking configuration,
trusted child instructions, child tools, and working directory. Do not change the
parent model or let selection expand permissions. Isolate child conversation state;
Pi's documented project instructions may still apply and must be distinguished
from parent transcript inheritance. Project-local agents require trust approval.

Control child extension/tool loading to prevent recursive delegation. Default to
no child extension discovery, and apply R12's per-agent explicit allowlist without
removing `--no-extensions`. Do not assume a built-in tool flag also disables tools
from loaded extensions; verify loading and activation behavior on the pinned Pi
version.

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
- parent decision ID when associated with a request-scoped gate;
- delegation-decision policy, recommendation, effective restriction, and override state;
- bounded selection probabilities/confidence when present;
- delegation-decision latency, model-chooser latency, available chooser/child usage,
  outcome and error category.

Create request-decision records independently of child-dispatch receipts. Local
execution, a blocked request, clarification-only completion and cancellation still
have a decision record even if no child exists. Record request generation, policy
source, base mode, invalidation/override reason and observed outcome, including
no-execution or mixed execution. Decision IDs and dispatch IDs are distinct; link
rather than fabricate a dispatch for local work. Include delegation-gate usage
when available as well as latency in total resource accounting.

Exclude raw prompts, task bodies, repository contents, and secrets from default
receipts. Do not store raw service error bodies without sanitization. Child output
in Pi's normal transcript follows Pi's own storage behavior; receipt redaction
must not be marketed as redacting the whole Pi session. No hidden reasoning logs.
Telemetry failure may warn without blocking otherwise permitted work. Report
unknown costs as unknown; do not invent a textual explanation for Jev's decision.

### R12 — Per-agent child-extension allowlist

A trusted agent may define `childExtensions` as an array of extension names or
explicit paths. Missing or empty arrays preserve the existing child surface:
built-in tools only and no explicit `-e` arguments. This is opt-in and must never
widen the default. Keep `--no-extensions` in every child launch so discovery stays
disabled; append one `-e <absolute-entry>` pair per resolved allowlist entry, and
continue to use `--tools` as the activation allowlist across built-in and extension
tools.

Resolve a name only from Pi package declarations installed in the effective
settings sources: `<agentDir>/settings.json` (where `PI_CODING_AGENT_DIR` overrides
`~/.pi/agent`) and the trusted project's `.pi/settings.json`. Read each `packages`
entry, locate the installed package according to Pi's npm, git, or local-package
layout, and derive extension entries from that package's `pi.extensions` manifest.
Do not guess conventional entry filenames. Apply Pi's package identity and project
override precedence. Resolve `~` and absolute path selectors explicitly; paths
must exist. A name that is absent or ambiguous, a missing path, an invalid manifest,
or a package with no declared extension entry is a launch error for that dispatch.
Never silently skip a requested extension.

An explicit path must resolve to an extension entry declared by an owning package
manifest; a package directory may resolve only through its manifest. Reject
`pi-delegateau` by package identity, canonical entry identity, and resolved package
root regardless of how it was selected. Also reject `delegate_task` in every child
tool list. No allowlist or alias may create recursive delegation.

Validate child tools against the union of approved built-ins and tool names
provided by the resolved allowlisted extensions. Tool ownership must come from
runtime extension metadata or a bounded, isolated registration probe; filenames
and documentation are not proof. Unknown names fail before child launch. Preserve
the existing approval rule for `bash`, `powershell`, `edit`, and `write`: extension
loading cannot make those tools newly approvable or bypass current policy.

### R13 — Parallel slot pool, FIFO queue, and batch dispatch

Replace the single admission lock with a configured slot pool. `concurrency`
defaults to 3 and `maxQueueDepth` is finite and configurable. Each assignment owns
one queue position or one slot, never both. If a slot is available it starts
immediately; otherwise it enters one instance-local FIFO queue. A full queue fails
clearly before sensing or launch. A queued caller waits, and every position change
is reported through `onUpdate` using a one-based queue position.

Queue cancellation is terminal: remove the entry, wake its waiter, update later
positions, and never start it or consume a slot. Recheck cancellation while
transferring an entry from queue to running. A running cancellation only aborts
its owned work and lets the normal settle path decide whether the slot is released
or blocked. Centralize slot settlement in exactly one operation and make it
idempotent; no abort, dequeue, startup failure, or late callback may double-release.

An observed child exit and verified process-group sweep release the slot after the
dispatch settles, regardless of child success or failure. If either cannot be
verified, convert that occupied slot to blocked/degraded state and never silently
reuse it. Other healthy slots remain usable. Status reports configured capacity,
running, queued and blocked counts plus sanitized blocked reasons. Shutdown
cancels queued entries and running work, then lets running cleanup settle under
the same truthfulness rule.

`delegate_task` accepts either the existing single assignment fields or an
`assignments` array. Reject mixed forms, empty batches, and batches that cannot fit
the configured running-plus-queue capacity at admission time. Every batch element
is independently validated, selected, queued, launched, cancelled, receipted and
identified by its own dispatch ID. Run batch elements concurrently subject to the
same pool and return results in input order. One element's ordinary failure does
not erase sibling receipts; cancellation propagates to queued and running siblings.
The batch result must not collapse distinct outcomes into one claimed success.

### R14 — Quota-aware provider eligibility and Jev pressure

Read provider-owned quota snapshots at dispatch/request resolution time and normalize
provider-specific windows into provider, window name, used fraction, remaining
fraction, and reset metadata when available. A missing or stale provider snapshot is
unknown, not unlimited capacity; never infer headroom from model price, provider
name, or the quota state the parent used manually outside this extension.

Before Jev sees candidates, exclude a provider when any observed limiting window has
at most the exhaustion floor (2% remaining by default). The 5h/session, weekly, and
monthly windows are all independent constraints; the tightest one binds. Revalidate
this hard eligibility immediately before child launch so a provider that crosses the
floor while Jev is deciding cannot be launched.

Above the floor, pass bounded per-provider headroom and reset facts to both the child
model selector and the local-versus-delegated gate. Jev may use that as a soft
pressure signal, but it must not treat an unknown provider as healthy or invent a
quota value. This affects automatic Jev routing only; manual Hermes quota handling
and user policy remain separate. Quota reads are snapshots, not measurement passes,
and no per-model quota coefficient is inferred from them.

### R10 — Evidence and useful scope

Test the actual extension dispatch path and hooks, not only internal functions.
Use isolated Pi state and disposable workspaces. Include a non-git workspace to
prove the product has not inherited pi-foreman's HEAD-based dependency.

Run a live Jev-to-child smoke test and a paired fixed-versus-Jev pilot under the
same delegation mode. Include sensing overhead, failures, quality checks, total
latency, and available usage/cost. Evaluate delegation-mode changes separately.
For the Jev delegation gate, test manual, advisory, enforced, override, failure,
and cancellation through the real parent run path. Include mode composition,
request expiry/steering, local-only receipts and delayed-handler ordering. Before
building enforcement, complete live chooser-to-child and verified delegated-task
checks (T05/T11), cancellation/admission prerequisites, and the advisory-path live
check. Compare gate policies with child selection held constant; count parent,
child, delegation-gate and model-chooser costs/usage where available.
Do not claim savings, compatibility, or completion from mock fixtures. A provider
or credential blocker leaves live acceptance incomplete, not silently waived.

## 5. Minimal implementation shape

Use a handful of modules with real consumers, not a scheduler framework:

- Extension entry: tool/commands and mode lifecycle; dedicated modules own batch orchestration, extension resolution and dispatch admission.
- Configuration/eligibility: profiles, exact identities, pins and hard constraints.
- Delegation gate: optional Jev local-versus-delegated decision and tool-surface
  policy.
- Jev selector: one model Choice request, deadline, validation and eligible fallback.
- Child runner: explicit launch, event normalization, limits, cancellation/cleanup.
- Receipts: local safe metadata and UI reporting.

Separate lifecycles:

- Parent request: `accepted -> deciding/policy resolution -> local and/or delegated
  execution -> settled`. Failure can enter a blocked state with explicit recovery.
  Cancellation or material steering invalidates the request generation. No child
  is necessary for this lifecycle or its receipt to complete.
- Child dispatch: `validating -> queued/admitted -> selecting -> running ->
  cleaning-up -> settled|blocked`. Errors and cancellation enter cleanup. Fixed/
  pinned paths skip model sensing, not eligibility. A rejected full-queue entry
  acquires no slot. Child model selection is not revisited after launch.

One effective-policy resolver combines stable user mode with the request gate for
both tool presentation and actual guards. Manual policy makes no delegation-gate
call, but Jev child-model selection can still occur. Keep admission, request
cancellation and child cleanup distinct rather than overloading one state machine.

## 6. Acceptance contracts

| ID | Contract | Requirements |
| --- | --- | --- |
| T01 | Standalone load, attribution and supported API integration without pi-foreman installed | R01 |
| T02 | Real tool invocation launches explicit-model child; parent model unchanged; execution errors reported accurately | R02, R07 |
| T03 | Dispatch admission holds capacity through cleanup; terminal cleanup permits later work and unverified cleanup remains blocked | R02, R08, R13 |
| T04 | Pins/default/single-candidate/empty-set precedence and eligibility enforced without unnecessary Jev calls | R03, R05 |
| T05 | Live Jev Choice reaches the real child launch and applied model matches the validated selection | R04, R07 |
| T06 | Sensor failures use only eligible fallback; changed eligibility blocks an invalid launch | R03, R05 |
| T07 | Both enforced modes block direct and dynamically registered prohibited tools; normal/deactivated mode works | R06 |
| T08 | Child context/tool isolation prevents parent transcript inheritance and model-facing recursive delegation | R02, R07 |
| T09 | Pre-cancel, sensing cancel, running cancel, limits and shutdown leave no late launch or owned process leak | R05, R08 |
| T10 | No sensing under disclosure prohibition; default receipts omit private payloads and secrets | R09 |
| T11 | Verified delegated task works in a non-git workspace without plans, gates, validator or remediation | R01, R07, R10 |
| T12 | Paired fixed/Jev pilot reports quality and total overhead honestly, with failures and unknown costs | R09, R10 |
| T13 | Manual/advisory gate uses bounded comparative state; live recommendation reaches the parent, permits disagreement, and distinguishes sensor failure from cancellation | R10, R11 |
| T14 | Enforced gate intersects base policy, skips policy-determined decisions, handles unavailable paths, and never grants tools or bypasses disclosure restrictions | R06, R09, R11 |
| T15 | One judgment per request generation; awaited ordering, steering/expiry, override and late responses cannot leak policy across runs or reclassify child returns | R06, R08, R11 |
| T16 | Gate failure blocks protected execution but preserves user recovery; overrides are visible, request-scoped and cannot widen base permissions | R06, R08, R11 |
| T17 | Local-only, blocked, no-execution, cancelled and mixed outcomes have independent decision receipts; child dispatches link without claiming unobserved agreement | R09, R11 |
| T18 | Per-agent child-extension allowlists resolve Pi package manifests and explicit paths fail closed; absent/empty stays built-in-only and pi-delegateau/delegate_task cannot enter a child | R07, R08, R12 |
| T19 | Configured parallel slots overlap real children, FIFO overflow waits with position updates, queued cancellation never starts late, and blocked cleanup degrades only its owning slot | R02, R08, R13 |
| T20 | Single form remains compatible; batch assignments receive independent dispatch IDs, ordered results and receipts while sharing the same bounded pool and cancellation rules | R07, R09, R13 |
| T21 | Provider-owned quota windows hard-exclude near-exhausted providers before Jev, revalidate before launch, and expose non-authoritative headroom pressure with unknown state preserved | R03, R04, R05, R14 |

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
