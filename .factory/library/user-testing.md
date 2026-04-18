# User Testing

Guidance for validators on how to verify behavioral assertions from `validation-contract.md`.

## Validation Surface

This mission has **no user-facing UI/CLI surface**. The "user" of the code under change is the `@enbox/agent` test suite itself. All validation is done through:

- **`bun test`** — the bun:test runner, executed from `/tmp/fix-eager-send/packages/agent/`.
- **`bash + rg + grep`** — pattern scans of test output and source files for forbidden strings / removed hacks.
- **`Bun.spawn`** — for assertions that need to inspect the stderr of a test subprocess separately (e.g., VAL-HARNESS-005).

There is NO browser, CLI, GUI, or HTTP-API surface to validate.

## Testing Infrastructure

Required infrastructure is encoded in `.factory/services.yaml` (Pkarr relay, Postgres, MySQL, NATS, DWN server). `init.sh` starts everything and is idempotent.

Every validator subprocess must have `DID_DHT_GATEWAY_URI=http://localhost:7527` in its environment.

## Validation Concurrency

**Max concurrent validators: 1** (serial only).

Rationale:
- The `@enbox/agent` test suite exercises a shared DWN server on `localhost:3000` and shared Postgres on `localhost:5433`. Running two `bun test` processes concurrently would produce cross-test state corruption (tenant DIDs, records, sync cursors) that would obscure the mission's actual invariant.
- The assertion VAL-FLAKE-001 requires TEN consecutive runs of the same e2e spec and asserts zero unhandled errors across the aggregation. Interleaving with another test run would pollute this aggregation.
- The machine has generous resources (32 cores, 256 GB RAM), but concurrency is constrained by the shared port-3000 DWN server, not by CPU/RAM.

If validation runtime becomes a bottleneck in future missions, the right fix is to partition the shared DWN server per-validator with a different port range — not to parallelize against the same server.

## Known Testing Constraints

- **`bun test` exit code does NOT always reflect unhandled errors between tests.** A spec can have `1 pass, 0 fail` in the summary AND an `# Unhandled error between tests` block above the summary, AND still exit with code 0. Therefore assertions that check for unhandled-error leakage MUST grep the captured output, not rely on the exit code.
- **Forbidden-string grep can produce false positives when test names include the same text.** Example: a test title that includes `TestAgent: Agent DID is not set` will match naïve `grep` on full logs even when no runtime leak occurred. Prefer patterns anchored to runtime diagnostics (`^# Unhandled error between tests`, `LEVEL_DATABASE_NOT_OPEN`, or `TestAgent: Agent DID is not set` lines outside test title formatting) and corroborate with surrounding context.
- **VAL-CROSS integration tests currently live in `tests/dwn-api-drain-integration.spec.ts`.** If a command like `bun test tests/dwn-api.spec.ts -t 'drain integration'` returns `0 tests`, run the dedicated integration spec directly.
- **The failing spec `e2e-delegate-cross-device.spec.ts` is historically flaky.** The first run may pass even before the mission's fix lands (the flake is probabilistic). To prove the fix, VAL-FLAKE-001 requires 10 consecutive green runs, which makes the probabilistic flake vanishingly unlikely to hide behind.
- **`Bun.spawn` returns a reader for stderr and stdout.** Use `new Response(proc.stderr).text()` (or similar) to capture output. Do NOT rely on timing — await the process's `.exited` promise before grepping.
- **`sinon.stub(console, 'warn')` must be restored in `afterEach`** or the next test in the same file will see a stubbed `console.warn`.

## Validator Interaction Notes

- When the scrutiny validator reviews code, it should focus on:
  - Correct `.finally` placement in `trackEagerSend` (the `.delete` must always run, both success and failure).
  - Fast-path in `drainPendingEagerSends` (empty-set check BEFORE calling `Promise.allSettled`).
  - Ordering in `clearStorage` / `closeStorage` — drain must happen before any destructive operation.
  - Preservation of the `console.warn` message format.
- When the user-testing validator runs, its flow-validator subagents will execute the `verificationSteps` from each feature AND the `reproduction commands` embedded in each `VAL-*` assertion. All services must be up before it starts.

## Flow Validator Guidance: bun-test-shell

Surface: `bun:test` + shell log inspection.

Isolation and boundaries:
- Run validators **serially** (max concurrency `1`) against the shared local DWN server on `localhost:3000`.
- Do not start/stop Docker services from inside flow validators unless explicitly required by the assigned assertion group.
- Stay within `/tmp/fix-eager-send` and write artifacts only to assigned report/evidence paths.
- Set `DID_DHT_GATEWAY_URI=http://localhost:7527` in each validator command invocation.
- Use deterministic log capture (`2>&1 | tee ...`) and `grep -c` for forbidden diagnostics; do not rely on process exit code alone for unhandled-error assertions.
