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
