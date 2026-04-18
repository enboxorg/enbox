---
name: agent-fix-worker
description: Implements focused fixes inside @enbox/agent with TDD, bun:test + sinon, and strict preservation of observability and public-signature contracts.
---

# agent-fix-worker

NOTE: Startup (read mission.md, AGENTS.md, `init.sh`, baseline tests) and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE specific to agent-package fixes.

## When to Use This Skill

Every feature in the `eager-send-drain` milestone of this mission. Use for:
- Feature 1: adding the tracker API to `AgentDwnApi` and wiring `writeContextKeyRecord`
- Feature 2: wiring drain into `PlatformAgentTestHarness.clearStorage()` / `closeStorage()`
- Feature 3: replacing setTimeout hacks in 2-3 test files + adding cross-area integration tests
- Feature 4: end-to-end flake regression guard (10x e2e run + full suite run + changeset)

## Required Skills

None. This mission has no browser, CLI, or desktop-app surface — only `bun test` invocations. Everything is done via shell commands and file edits.

## Work Procedure

### 0. Orient yourself (once per session)

1. Read `mission.md`, `AGENTS.md`, `features.json` (find your pre-assigned feature), and `validation-contract.md` (focus on the VAL-* assertions your feature's `fulfills` claims).
2. Read `.factory/library/architecture.md` and `.factory/library/user-testing.md`.
3. Verify environment:
   ```bash
   curl -sf http://localhost:3000/info  # DWN server
   docker compose -f docker-compose.test.yaml ps  # test services
   echo $DID_DHT_GATEWAY_URI  # must be set
   ```
   If any is missing, run `bash .factory/init.sh`.
4. Run the **baseline test command** for your feature to confirm the suite is green BEFORE you change anything:
   ```bash
   cd packages/agent && bun test tests/<relevant-file>.spec.ts
   ```
   Note the pre-change pass count in your handoff's `verification.commandsRun`.

### 1. Write tests first (RED)

For every VAL-* assertion in your feature's `fulfills`:

1. Write a failing `it('should ...', ...)` that exercises the assertion through the public surface described in the contract. Use `bun:test` + `sinon`.
2. The test MUST fail for the reason the assertion describes — not for a stub/mock setup issue. Run it with `bun test <file> -t '<partial name>'` and confirm the failure mode matches the contract's "fail criteria".
3. For assertions that require a sub-process (VAL-HARNESS-005), write the outer test that `Bun.spawn`s the inner spec and greps its stderr.
4. Commit all new tests in ONE `git add && git commit -m 'test(agent): failing tests for <feature>'` (do NOT push yet; do not mix with production code).

### 2. Implement (GREEN)

1. Make the minimum production change that turns the failing tests green. Follow `AGENTS.md` conventions (explicit return types, `_` prefix for private fields, colon-aligned object literals, JSDoc on public methods).
2. Re-run the tests with `bun test <file>` and confirm they all pass.
3. Run adjacent tests to catch regressions:
   ```bash
   cd packages/agent && bun test tests/dwn-api.spec.ts
   cd packages/agent && bun test tests/dwn-key-delivery.spec.ts
   ```
4. Run the full agent test suite to catch wider regressions:
   ```bash
   cd packages/agent && bun run test:node 2>&1 | tee /tmp/feature-<id>-full.log
   tail -5 /tmp/feature-<id>-full.log  # confirm 0 fail
   ```
5. Run lint:
   ```bash
   bun run lint  # from repo root
   ```
6. Run build:
   ```bash
   bun run --filter @enbox/agent build
   ```

If any step fails:
- If caused by the new code: fix it.
- If caused by a pre-existing issue unrelated to the mission: DO NOT mask it. Note it in `whatWasLeftUndone` / `discoveredIssues` and return to orchestrator.

### 3. Commit the production change

```bash
git add <prod-files>
git commit -m 'fix(agent): <concise description>'
```

Match the commit-message style from `git log --oneline -10` on `main`.

### 4. Verify no forbidden-string regression (for Features 1-3)

Even if your feature's assertions don't include VAL-FLAKE-001/002 directly, run a sanity check:

```bash
cd packages/agent
bun test tests/e2e-delegate-cross-device.spec.ts 2>&1 | tee /tmp/sanity.log
grep -cE 'LEVEL_DATABASE_NOT_OPEN|TestAgent: Agent DID is not set|# Unhandled error between tests' /tmp/sanity.log
```

Expect `0`. If non-zero, your fix is incomplete — return to Step 2 with the failure details.

### 5. Handoff

Fill out the handoff fields thoroughly. See the Example Handoff below for the quality bar.

## Inviolable Rules (from AGENTS.md)

- **Never modify production code to satisfy tests.** If a test fails because a stub doesn't simulate reality, fix the stub.
- Do NOT change the `console.warn` message format on eager-send failure (verbatim observability contract).
- Do NOT change `writeContextKeyRecord`'s public signature or return value.
- Do NOT inspect the private `_pendingEagerSends` set from tests — use only the public `drainPendingEagerSends()` API.
- Do NOT add a `close()`/`dispose()` on `EnboxUserAgent` — out of scope.
- Do NOT bump versions in `package.json` — use a changeset file in the final feature.
- Do NOT run `bunx changeset version` locally.

## Example Handoff

```json
{
  "salientSummary": "Added eager-send tracker to AgentDwnApi (private _pendingEagerSends Set, private trackEagerSend wrapper, public drainPendingEagerSends with fast-path). Wired through writeContextKeyRecord in dwn-key-delivery.ts, preserved the verbatim console.warn message. 10 new tests (VAL-TRACKER-001..010) all pass; full agent suite: 1449 pass, 0 fail; 0 unhandled rejections; lint + build clean.",
  "whatWasImplemented": "Added `private readonly _pendingEagerSends: Set<Promise<void>> = new Set()` field and `private trackEagerSend(p: Promise<void>): Promise<void>` helper to `AgentDwnApi` in packages/agent/src/dwn-api.ts (lines 253-275). Added `public async drainPendingEagerSends(): Promise<void>` with fast-path for empty set (lines 277-289). Modified `writeContextKeyRecord` callback binding (line 1952) to pass `this.trackEagerSend.bind(this)`. Updated `WriteContextKeyRecordFn` signature and internals in packages/agent/src/dwn-key-delivery.ts (lines 118-210) to accept and apply `trackEagerSend` around the existing `eagerSend(tenantDid, message).catch(...)` expression. Preserved the console.warn message exactly: `AgentDwnApi: Eager send of contextKey record '<recordId>' to remote DWN failed: <err>. Sync will deliver it later.`. Added 10 failing tests in packages/agent/tests/dwn-api.spec.ts under a new `describe('AgentDwnApi.drainPendingEagerSends', ...)` block, then implemented the tracker to turn them green.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "cd packages/agent && bun test tests/dwn-api.spec.ts -t 'AgentDwnApi.drainPendingEagerSends'", "exitCode": 0, "observation": "10 pass, 0 fail — all VAL-TRACKER-001..010 green" },
      { "command": "cd packages/agent && bun test tests/dwn-api.spec.ts", "exitCode": 0, "observation": "All pre-existing dwn-api tests still pass. 87 pass, 0 fail." },
      { "command": "cd packages/agent && bun run test:node", "exitCode": 0, "observation": "Full agent suite: 1451 pass, 0 fail, 0 skipped; grep of output for 'LEVEL_DATABASE_NOT_OPEN' / 'TestAgent: Agent DID is not set' / '# Unhandled error between tests' yielded 0 matches for each." },
      { "command": "bun run lint", "exitCode": 0, "observation": "Lint clean across all packages" },
      { "command": "bun run --filter @enbox/agent build", "exitCode": 0, "observation": "Agent package built cleanly, no TS errors" },
      { "command": "cd packages/agent && bun test tests/e2e-delegate-cross-device.spec.ts", "exitCode": 0, "observation": "Sanity check: e2e spec passes, no forbidden strings in output" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "packages/agent/tests/dwn-api.spec.ts",
        "cases": [
          { "name": "AgentDwnApi.drainPendingEagerSends > resolves immediately when no sends are pending", "verifies": "VAL-TRACKER-001" },
          { "name": "AgentDwnApi.drainPendingEagerSends > waits for a single in-flight successful eager send", "verifies": "VAL-TRACKER-002" },
          { "name": "AgentDwnApi.drainPendingEagerSends > waits for a single in-flight eager send that rejects", "verifies": "VAL-TRACKER-003" },
          { "name": "AgentDwnApi.drainPendingEagerSends > waits for all concurrently in-flight eager sends", "verifies": "VAL-TRACKER-004" },
          { "name": "AgentDwnApi.drainPendingEagerSends > does not reject even when every tracked send rejects", "verifies": "VAL-TRACKER-005" },
          { "name": "AgentDwnApi.drainPendingEagerSends > is idempotent after the tracker has drained", "verifies": "VAL-TRACKER-006" },
          { "name": "AgentDwnApi.drainPendingEagerSends > uses a snapshot taken at drain-start and does not await sends registered after", "verifies": "VAL-TRACKER-007" },
          { "name": "AgentDwnApi.drainPendingEagerSends > releases settled entries so new sends can be drained independently", "verifies": "VAL-TRACKER-008" },
          { "name": "AgentDwnApi.writeContextKeyRecord > returns the recordId synchronously with the local write and does not block on the tracked eager send", "verifies": "VAL-TRACKER-009" },
          { "name": "AgentDwnApi.drainPendingEagerSends > preserves the console.warn message on eager-send failure", "verifies": "VAL-TRACKER-010" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

Return immediately — do NOT attempt to fix outside scope — if:

- The failing tests require modifying files outside the in-scope list in `AGENTS.md`.
- Lint/build fails due to a pre-existing issue unrelated to your feature (note it in `discoveredIssues`).
- A pre-existing test fails that is unrelated to your changes (document in `discoveredIssues` with the specific test name and failure mode — do NOT silence, skip, or "fix" it opportunistically).
- The DWN server on :3000 is unreachable and `bash .factory/init.sh` does not restore it.
- You discover a second fire-and-forget site in AgentDwnApi that wasn't covered by the mission's investigation (document in `discoveredIssues` — orchestrator decides whether to fold into this mission or defer).
- The verbatim `console.warn` message format is already broken on `main` (highly unlikely but check).
