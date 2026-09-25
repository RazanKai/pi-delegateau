# pi-delegateau

A Pi extension that uses **Jev** to decide when work should leave the current Pi
session and which child model should handle it.

That is the point of this extension. A model switcher can choose a model after a
routing decision has already been made; pi-delegateau asks Jev to make the
higher-level decision first: keep the task in the current session, or delegate a
bounded assignment to a child. When delegation is chosen, Jev selects the child
model from the eligible pool using the task, repository profile, model metadata,
cost signal, reachability, and quota headroom.

## How the decision flow works

For each request, the extension keeps two decisions distinct:

1. **Delegation decision:** Jev evaluates whether the task should remain in the
   current Pi session or be delegated. Configure `jev-suggest` for an advisory
   recommendation or `jev-enforce` to restrict direct execution when Jev selects
   delegation. Both are request-scoped.
2. **Child-model decision:** if a child assignment is launched, Jev chooses the
   model from the eligible candidate pool. Child thinking can be fixed with
   `childThinking`; provider exhaustion, reachability failures, and cancellation
   are enforced before launch.

The child receives its own session, selected model, trusted role instructions,
explicit tools, and bounded task context. It does not receive the parent
conversation or system prompt. Dispatch is bounded by a parallel slot pool and
FIFO queue; one `delegate_task` call may contain one assignment or a batch.

## Bootstrap and roles

A fresh project can build its initial pool with:

```text
/delegateau setup
/delegateau setup probe
/delegateau setup import <file>
/delegateau setup retrieve artificial-analysis <mapping-file>
/delegateau setup apply
```

Setup reads Pi's live model registry, keeps models with configured credentials,
preserves provider metadata, and requires confirmation before writing
`.pi/delegateau.json`; replacing an existing config additionally requires a second
explicit overwrite confirmation. For Ollama Cloud, `pi-ollama-cloud-link` supplies
that catalog and the provider-owned quota snapshot; catalog presence confirms that
the model is listed, not that a generation request will succeed. Reachability
probing is sequential and explicit; quota measurement is a separate opt-in stage.

## Configuration location

delegateau resolves its config in this order:

1. `<project>/.pi/delegateau.json` — the project config, when it exists.
2. `<agent-dir>/delegateau.json` — the global config, applied in every project
   that has no project config. The agent dir is `PI_CODING_AGENT_DIR`, else
   `~/.pi/agent`, the same root the receipt paths use.
3. Built-in defaults, when neither exists.

A project config REPLACES the global one; it is not merged with it, so a project
never runs on a half-global policy that no single file states. An unreadable file
fails closed at whichever level it was found rather than silently falling back to
defaults. `/delegateau status` reports which source is in effect:
`config=global (/home/user/.pi/agent/delegateau.json)`.

Benchmark evidence is acquired only by an explicit command. `setup import` reads a
local structured JSON document and makes no network request. `setup retrieve
artificial-analysis` is the one supported network adapter: it calls Artificial
Analysis's authenticated v2 Free-tier language-model endpoint
(`https://artificialanalysis.ai/api/v2/language/models/free`) with
`ARTIFICIAL_ANALYSIS_API_KEY` from the process environment, and it requires a
mapping from each stable Artificial Analysis model `id` to an exact live Pi
`provider/model` identity — it never infers an alias from a model name or a loose
slug similarity. That mapping is a reviewable JSON file; `scripts/build-aa-mapping.py`
produces it from live sources (`pi --list-models` plus the AA catalog) and emits a
pair only when exactly one AA entry matches a Pi model after documented
canonicalization, omitting anything ambiguous so those models stay visibly
unmeasured:
```text
ARTIFICIAL_ANALYSIS_API_KEY=... python3 scripts/build-aa-mapping.py aa-mapping.json
```
That request is sent only to `artificialanalysis.ai` and redirects are refused, so
the credential is never replayed to another host. Normalized records are bounded
(at most 8 per model, HTTPS sources only, records older than 730 days ignored —
enforced for records imported, retrieved **and** hand-written into a config) and
cached under the Pi agent state area
(`<agentDir>/delegateau/benchmarks.json`), outside the project config. Each
explicit retrieval call is also deadline- and byte-bounded (a hung transport or
body, or an oversize body, yields a sanitized diagnostic and writes no cache),
and the adapter promotes only the documented Free-tier composite indices
(Intelligence, Coding and Agentic Index); any other numeric `evaluations` field
becomes a bounded unsupported diagnostic. Values the record parser would reject —
an over-long version label, an out-of-range score — are normalized or reported at
acquisition time rather than stored and discarded on the next read. Every record
states whether its date is a source-reported measurement or an adapter retrieval
snapshot (`dateKind`).
Records are revalidated against the current live authenticated registry at every
review, and prior cache entries are revalidated before a merge applies the
per-model cap — freshly acquired records are placed first, so the cap evicts the
oldest evidence rather than the record just acquired, and every eviction is
reported. Malformed, stale, future-dated, unmatched or untrusted input stays
visibly unmeasured rather than being attached to a candidate. Import,
extension load, session start, ordinary setup review and dispatch never fetch
benchmark data.
Measured records are carried through the generated config into `CandidateProfile`,
into Jev's Choice criteria and candidate state, and into the bounded sanitized
route trace on each dispatch receipt (with an explicit `offeredToJev` flag, the
count actually offered, and a `truncated` flag when the trace's own cap clipped
the stored list); missing evidence never penalizes an unmeasured candidate.

The built-in role templates are:

- `scout` — read-only local codebase reconnaissance.
- `researcher` — web and documentation research with sources.
- `evidence-auditor` — independently checks research claims against sources.
- `worker` — implementation work with validation.
- `reviewer` — code review and small directly justified fixes.
- `oracle` — read-only second opinion that challenges assumptions.

The web roles can use either `pi-web-access` or `donsetch`; the selected extension
is recorded in the generated child configuration.

## Requirements

- Node.js `>=22.19.0`
- Pi coding agent `0.85.1` (the tested compatibility target)
- A `pi` executable on `PATH` when a child assignment is launched
- TypeSafe credentials for Jev decisions
- `pi-ollama-cloud-link` when using Ollama Cloud; it registers the `ollama-cloud`
  provider, supplies Pi's live model catalog, and publishes the usage snapshot
  delegateau reads for quota headroom. It is not needed for other providers.

## Development

```sh
npm install
env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL npm run check
```

Load the extension from a checkout:

```sh
pi -e /absolute/path/to/pi-delegateau/src/index.ts
```

The package also exposes `src/index.ts` through Pi's `pi.extensions` package
metadata.

## Configuration

The intended configuration lets Jev own both decisions:

```json
{
  "selection": "jev",
  "delegationDecision": "jev-suggest",
  "allowExternalSensing": true,
  "candidates": [
    {
      "provider": "provider-id",
      "id": "model-id",
      "description": "Registry-derived model metadata",
      "capabilities": ["code"],
      "provenance": "built-in"
    }
  ],
  "agents": {
    "worker": {
      "instructions": "Implement the assignment, validate it, and report changes precisely.",
      "tools": ["read", "bash", "edit", "write"]
    }
  }
}
```

`jev-enforce` can be used when direct parent execution must be restricted when
Jev recommends delegation. `fixed` selection and `manual` delegation are explicit
escape hatches for controlled operation and tests; they are not the purpose of
this extension.

Optional fields:

- `childThinking`: fixed thinking level for a child (`off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`); passed through to Pi.
- `agents.<name>.childExtensions`: opt-in package names or absolute/`~` paths.
  Names resolve from Pi's global/project package settings and each package's
  `pi.extensions` manifest.
- `limits.concurrency` (default 3) and `limits.maxQueueDepth` (default 20):
  bound running and waiting assignments.
- `limits.maxExpectedOutputChars` and `limits.maxGatePromptChars`: bound task
  context and the prompt sent to Jev.
- `allowedParentTools`: may remove tools from enforced modes but cannot re-admit
  dangerous execution tools.

## Safety and receipts

- Pi's core project-trust state is checked through `ctx.isProjectTrusted()` before
  configuration is read or a child is spawned. Project trust controls loading
  project-local Pi resources; it is not a sandbox.
- Jev-enforced failures fail closed instead of silently running locally.
- Candidate eligibility is filtered again immediately before launch.
- Provider-served model substitutions are disclosed in the tool result.
- JSONL receipts record stable outcome metadata without task bodies or raw prompts.

The child command defaults to `pi`; set `"piCommand": "/absolute/path/to/pi"`
when testing from a checkout without a globally installed Pi executable.

Use `delegate_task` with either the `agent`/`task` fields or an `assignments` array.
Each assignment receives an independent dispatch ID, lifecycle, and receipt. The
child runs with `--no-session`, `--no-extensions`, the selected model, approved
tools, and any explicitly allowlisted child extensions.

Useful control commands inside Pi:

- `/delegateau override local|delegate|manual` (current request only)
- `/delegateau enable delegate-execution`
- `/delegateau enable coordinator-only`
- `/delegateau disable`
