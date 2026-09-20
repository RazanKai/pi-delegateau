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
/delegateau setup apply
```

Setup reads Pi's live model registry, keeps models with configured credentials,
preserves provider metadata, and requires confirmation before writing
`.pi/delegateau.json`. Reachability probing is sequential and explicit; quota
measurement and external benchmark retrieval are separate opt-in stages.

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

## Documentation

- [Specification](docs/SPEC.md)
- [Development plan](docs/DEVPLAN.md)
- [Work log and verification receipts](docs/WORKLOG.md)
- [Attribution notice](NOTICE.md)
- [Third-party license](THIRD_PARTY_LICENSES/pi-foreman-MIT.txt)

This project is independently implemented and does not require `pi-foreman` at
runtime. See `NOTICE.md` for the ideas and license attribution used during
implementation.
