# pi-delegateau

A Pi extension that lets one Pi send a small, self-contained task to a second
Pi process.

The child gets its own session, one selected model, an explicit list of tools,
and only the task context. The parent keeps control of the overall work.

## What it does

- Starts one child Pi process per assignment, with a bounded parallel slot pool
  and FIFO queue; one tool call may contain one assignment or a batch.
- Selects a configured model by pin, fixed default, or optional TypeSafe Jev
  choice.
- Allows only trusted child agents and approved child tools, including tools from
  explicitly allowlisted child extensions.
- Reports progress, output, errors, cancellation, timeouts, and limits.
- Writes small JSONL receipts without task bodies or raw prompts.
- Optionally restricts the parent to coordinating and delegating instead of
  editing directly.

The parent can use the optional Jev-based local-versus-delegated gate. Set
`"delegationDecision": "jev-suggest"` for an advisory recommendation or
`"jev-enforce"` to restrict direct execution when Jev recommends delegation.
Enforcement fails closed if the decision service is unavailable; `manual` keeps
normal parent behavior. The decision is request-scoped and does not mutate later
conversation history.

It does not provide a planner, nested delegation, automatic review, repair loop,
worktree management, or correctness verdicts.

## Requirements

- Node.js `>=22.19.0`
- Pi coding agent `0.85.1` (the tested compatibility target)
- A `pi` executable on `PATH` when a child delegation is run
- TypeSafe credentials only when Jev selection is enabled

## Development

```sh
npm install
npm run check
```

Load the extension from a checkout:

```sh
pi -e /absolute/path/to/pi-delegateau/src/index.ts
```

The package also exposes `src/index.ts` through Pi's `pi.extensions` package
metadata.

## Configuration

Create `.pi/delegateau.json` in the project where Pi runs. A minimal fixed-model
configuration looks like this:

```json
{
  "selection": "fixed",
  "delegationDecision": "manual",
  "defaultModel": { "provider": "openai", "id": "gpt-4.1-mini" },
  "candidates": [
    {
      "provider": "openai",
      "id": "gpt-4.1-mini",
      "description": "Implementation and test work",
      "capabilities": ["code"],
      "provenance": "user"
    }
  ],
  "agents": {
    "worker": {
      "instructions": "Implement only the assignment and report what changed.",
      "tools": ["read", "bash", "edit", "write", "lens_diagnostics"],
      "childExtensions": ["pi-lens"]
    }
  }
}
```

Optional fields:

- `childThinking`: fixed thinking level for the child (`off`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`); passed to the child via
  `--thinking`.
- `agents.<name>.childExtensions`: opt-in package names or absolute/`~` paths.
  Names resolve from Pi's global/project package settings and each package's
  `pi.extensions` manifest. Missing or empty means built-ins only.
- `limits.concurrency` (default 3) and `limits.maxQueueDepth` (default 20):
  bound running and waiting assignments.
- `limits.maxExpectedOutputChars` / `limits.maxGatePromptChars`: bounds for
  the optional expected-output field and the prompt sent to the Jev
  delegation gate.
- `allowedParentTools`: may REMOVE tools from enforced modes but can never
  re-admit `bash`, `powershell`, `edit`, or `write`; `delegate_task` is
  always kept.

Trust and safety behavior:

- Delegation is refused when the host reports the project untrusted, before
  any project config is read or child command spawned.
- Enforced policies fail closed: a missing TypeSafe key, malformed config,
  or sensor failure installs a blocked restriction for the request instead of
  silently degrading.
- Decision receipts store stable error categories, never raw service error
  text, so prompt content cannot leak into receipts.
- Provider-served model evidence (`servedModel`) is recorded alongside the
  requested model; substitution is disclosed in the tool result.

The child command defaults to `pi`; set `"piCommand": "/absolute/path/to/pi"`
when testing from a checkout without a globally installed Pi executable.

The parent can use `delegate_task` with the existing `agent`/`task` fields or an
`assignments` array. Each assignment gets a distinct dispatch ID and receipt.
The extension starts another Pi process with `--no-session`, `--no-extensions`,
zero or more explicit `-e` entries, the chosen model, and the configured child
tools.

Useful commands inside Pi:

- `/delegateau status`
- `/delegateau override local|delegate|manual` (current request only)
- `/delegateau enable delegate-execution`
- `/delegateau enable coordinator-only`
- `/delegateau disable`

## Documentation

- [Specification](docs/SPEC.md)
- [Development plan and acceptance status](docs/DEVPLAN.md)
- [Work log and verification receipts](docs/WORKLOG.md)
- [Attribution notice](NOTICE.md)
- [Third-party license](THIRD_PARTY_LICENSES/pi-foreman-MIT.txt)

## Status

The implementation and local suite are exercised hermetically without TypeSafe
credentials. Live child-extension and bounded-parallel dispatch evidence is
recorded in `docs/WORKLOG.md`; the fixed-versus-Jev pilot remains separate.

Known limitations:

- A competing extension that registers `delegate_task` first shadows this
  extension; Pi 0.85.1 offers no load-time seam to reject that (Pi emits a
  diagnostic), and `/delegateau status` reports suspected shadowing.

This project is independently implemented. It does not require `pi-foreman` at
runtime. See `NOTICE.md` for the ideas and license attribution used during
implementation.
