# Architecture: Eager-Send Tracker and Harness Drain

## System under change

A single narrow subsystem inside `@enbox/agent`:

```
packages/agent/src/
├── dwn-api.ts              ← AgentDwnApi (adds tracker API)
├── dwn-key-delivery.ts     ← writeContextKeyRecord (wraps fire-and-forget with tracker)
└── test-harness.ts         ← PlatformAgentTestHarness (drains before teardown)
```

No other package is touched. No other subsystem of `@enbox/agent` is touched (sync engine, secret store, vault, did resolver, registration, etc. are all outside scope).

## Components

### `AgentDwnApi` (existing, modified)

Adds three members:

- **`_pendingEagerSends: Set<Promise<void>>`** — private instance field. Stores currently in-flight eager-send promises.
- **`trackEagerSend(p: Promise<void>): Promise<void>`** — private. Adds `p` to the set, attaches a `.finally(() => this._pendingEagerSends.delete(p))`, and returns `p` unchanged. Callers can still `.catch(...)` on the returned promise.
- **`drainPendingEagerSends(): Promise<void>`** — public. Snapshots the current set, `Promise.allSettled`s the snapshot, resolves `void`. Fast path when set is empty (resolves immediately without calling `allSettled`). Never rejects.

The existing eager-send call site in `dwn-api.ts::writeContextKeyRecord(...)` (which routes to `writeContextKeyRecordFn(...)` in `dwn-key-delivery.ts`) passes `trackEagerSend.bind(this)` alongside the existing `eagerSendContextKeyRecord.bind(this)`.

### `writeContextKeyRecord` (in `dwn-key-delivery.ts`)

Signature gains one new parameter `trackEagerSend: (p: Promise<void>) => Promise<void>`. The existing line
```ts
eagerSend(tenantDid, message).catch((err: Error) => { console.warn(...); });
```
becomes
```ts
trackEagerSend(eagerSend(tenantDid, message).catch((err: Error) => { console.warn(...); }));
```

The `console.warn` message format is preserved verbatim.

### `PlatformAgentTestHarness`

Two methods gain a drain-before-teardown step:

- **`clearStorage()`** — inserts `await this.agent.dwn.drainPendingEagerSends();` at the top of the method, BEFORE `this.agent.agentDid = undefined` and BEFORE any store `.clear()` calls.
- **`closeStorage()`** — inserts `await this.agent.dwn.drainPendingEagerSends();` at the top, BEFORE any store `.close()` calls.

Both drains are safe when no sends are pending (fast path).

## Data flow (runtime)

1. Test calls `agent.dwn.writeContextKeyRecord(...)`.
2. Local `processRequest` (RecordsWrite) persists the record → resolves `recordId`.
3. `writeContextKeyRecord` invokes `trackEagerSend(eagerSend(...).catch(warnHandler))`.
   - Promise is added to `_pendingEagerSends`.
   - `.finally` is attached to auto-remove on settlement.
4. `writeContextKeyRecord` returns `recordId` immediately (does not block on eager send).
5. Eager send runs in the background: DID resolution → local DWN read → HTTP RPC to remote DWN.
   - Success → `.finally` removes from set.
   - Failure → `.catch` logs `console.warn`, `.finally` removes from set.
6. Test completes; teardown calls `clearStorage()` / `closeStorage()`.
7. Teardown awaits `drainPendingEagerSends()` → `Promise.allSettled([...pending])` → all eager sends settle before LevelDB/stores are closed.
8. `agentDid = undefined` and store `.close()` run only after drain resolves → no late access to a closed DB or cleared agent DID.

## Invariants

1. **No eager-send promise outlives `clearStorage()` or `closeStorage()`.** This is the mission's core invariant.
2. **`drainPendingEagerSends()` never rejects.** Rejections are absorbed via `allSettled`. Individual rejections still fire their `.catch(warn)` handler (observability preserved).
3. **`drainPendingEagerSends()` fast-paths when empty.** Zero overhead on the 99% of tests that never call `writeContextKeyRecord`.
4. **Snapshot semantics.** Drain awaits only sends registered at the moment it was invoked. Sends registered during an in-flight drain are not joined retroactively; a subsequent drain call handles them.
5. **Signature stability.** `writeContextKeyRecord(...)`'s public signature and return value are unchanged. Only its internal dependency list (for DI stubbing in tests) gains one new callback parameter.
6. **Observability stability.** The verbatim `console.warn` message pattern on eager-send failure is preserved.

## Out of scope

- No `close()` / `dispose()` method is added to `EnboxUserAgent` or `AgentDwnApi`. Production shutdown design is a larger, separate refactor.
- No changes to the `SyncEngineLevel` generation-counter pattern.
- No changes to other fire-and-forget sites in `packages/agent/src` (all other `.catch(...)` or `void promise` patterns in the agent package are inside the sync engine's existing `_engineGeneration`-guarded lifecycle — not in AgentDwnApi).
- No changes to the DWN SDK, auth package, API package, browser package, or server package.
