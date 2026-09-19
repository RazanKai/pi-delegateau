# pi-delegateau

A Pi extension that lets one Pi send a small, self-contained task to a second
Pi process.

The child gets its own session, one selected model, an explicit list of tools,
and only the task context. The parent keeps control of the overall work.

## What it does

- Starts one child Pi process for each accepted delegation.
- Selects a configured model by pin, fixed default, or optional TypeSafe Jev
  choice.
- Allows only trusted child agents and approved child tools.
- Reports progress, output, errors, cancellation, timeouts, and limits.
- Writes small JSONL receipts without task bodies or raw prompts.
- Optionally restricts the parent to coordinating and delegating instead of
  editing directly.

Today the parent decides whether to delegate. The optional Jev-based
local-versus-delegated decision is specified as a planned follow-up in
[`docs/SPEC.md`](docs/SPEC.md) and [`docs/DEVPLAN.md`](docs/DEVPLAN.md).

It does not provide a planner, queue, parallel workers, automatic review, repair
loop, worktree management, or correctness verdicts.

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
  "defaultModel": { "provider": "openai", "id": "gpt-4.1-mini" },
  "candidates": [
    {
      "provider": "openai",
      "id": "gpt-4.1-mini",
      "description": "Implementation and test work",
      "capabilities": ["code", "tests"],
      "provenance": "user"
    }
  ],
  "agents": {
    "worker": {
      "instructions": "Implement only the assignment and report what changed.",
      "tools": ["read", "bash", "edit", "write"]
    }
  }
}
```

The parent can then use the `delegate_task` tool with an agent name and a
self-contained task. The extension starts another Pi process with
`--no-session`, `--no-extensions`, the chosen model, and the configured child
tools.

Useful commands inside Pi:

- `/delegateau status`
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

The implementation and local tests are complete. The following still require a
real configured environment: a live provider-backed child run, a credentialed
Jev-to-child run, descendant-cleanup testing, and a fixed-versus-Jev pilot.

This project is independently implemented. It does not require `pi-foreman` at
runtime. See `NOTICE.md` for the ideas and license attribution used during
implementation.
