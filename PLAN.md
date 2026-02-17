# Sparse Merkle Tree Sync: Implementation Plan

## Overview

Replace the EventLog + watermark-based cursor sync with a Sparse Merkle Tree (SMT)
state index that enables O(1) "are we in sync?" checks and O(log n) set
reconciliation between DWN nodes. This eliminates the need for ordered event
replay, cursor management, and the unbounded anti-echo history store.

The change touches three layers:
1. **dwn-sdk-js** -- new `StateIndex` store interface + SMT implementation,
   new `MessagesSync` DWN message type, removal of `EventLog`
2. **agent** -- rewrite `SyncEngineLevel` to use SMT root comparison +
   dependency-aware message processing
3. **dwn-sql-store / dwn-server** -- SQL `StateIndex` implementation, config
   wiring

---

## Phase 1: SMT Core in `dwn-sdk-js`

### 1.1 Implement the Sparse Merkle Tree data structure

Create `packages/dwn-sdk-js/src/smt/` with:

| File | Purpose |
|------|---------|
| `sparse-merkle-tree.ts` | Core SMT implementation: insert, delete, root hash, membership proof, non-membership proof, diff |
| `smt-types.ts` | Types: `SMTProof`, `SMTNode`, `SMTConfig` |
| `smt-store.ts` | Interface for SMT node persistence (so it can be backed by LevelDB or SQL) |
| `smt-store-level.ts` | LevelDB-backed SMT node store |
| `smt-utils.ts` | Hashing utilities (SHA-256 over messageCid keys) |

**Key design decisions:**

- **Key space**: 256-bit (SHA-256 hash of messageCid). The messageCid is already
  a CIDv1(SHA-256(CBOR(message))), so hashing it again gives a uniform
  distribution across the 2^256 key space.
- **Tree depth**: 256 (one level per bit of the key hash). In practice, only
  paths to occupied leaves are stored (sparse).
- **Hash function**: SHA-256 via `@noble/hashes` (already a transitive dep via
  `@noble/ed25519`). Internal nodes store `H(left || right)`.
- **Empty subtree optimization**: Precompute `defaultHash[depth]` for all 256
  levels. An empty subtree at depth `d` has hash `defaultHash[d]`. This avoids
  storing empty nodes.
- **Persistence**: Nodes are stored in a flat key-value store keyed by their
  hash. The root hash is stored separately per tenant (and optionally per
  protocol).
- **Partitioning**: Per-tenant, with optional per-protocol sub-trees. A tenant's
  "global" root is the root of the tree containing ALL messageCids for that
  tenant. A protocol-scoped root contains only messageCids matching that
  protocol's events.

**Diff algorithm:**

Two SMT roots can be compared by walking the tree top-down. At each internal
node, if left/right child hashes match, skip that subtree. If they differ,
recurse. This identifies the set of leaf keys that differ in O(k * log n) where
k is the number of differences, without enumerating the full set.

```
diffRoots(localRoot, remoteRoot) -> { onlyLocal: string[], onlyRemote: string[] }
```

For the remote side, the diff requires the remote to respond to subtree hash
queries. This is what the new `MessagesSync` protocol handles (see Phase 2).

### 1.2 Create the `StateIndex` interface

Create `packages/dwn-sdk-js/src/types/state-index.ts`:

```typescript
export interface StateIndex {
  open(): Promise<void>;
  close(): Promise<void>;
  clear(): Promise<void>;

  // Core operations
  insert(tenant: string, messageCid: string, indexes: KeyValues): Promise<void>;
  delete(tenant: string, messageCids: string[]): Promise<void>;

  // State queries
  getRoot(tenant: string): Promise<Uint8Array>;
  getRoot(tenant: string, protocol: string): Promise<Uint8Array>;

  // Proof generation (for remote sync protocol)
  getSubtreeHash(tenant: string, prefix: BitPath): Promise<Uint8Array>;
  getSubtreeHash(tenant: string, prefix: BitPath, protocol: string): Promise<Uint8Array>;

  // Diff support
  getLeaves(tenant: string, prefix: BitPath): Promise<string[]>;

  // Backward compat: filtered queries for MessagesQuery (if we keep it)
  // (see Phase 1.4 discussion below)
}
```

This replaces `EventLog` at every call site. The `insert()` and `delete()` calls
have the same signatures minus the watermark return. The `indexes` parameter is
preserved for protocol-scoped tree maintenance (we need `protocol` from the
indexes to update the per-protocol sub-tree).

### 1.3 Implement `StateIndexLevel`

Create `packages/dwn-sdk-js/src/state-index/state-index-level.ts`:

- Wraps `SparseMerkleTree` with LevelDB-backed `SMTStoreLevel`
- Maintains one global SMT per tenant
- Maintains per-protocol SMTs (lazily created on first insert with a
  `protocol` index)
- On `insert(tenant, messageCid, indexes)`:
  1. Insert into the tenant's global SMT
  2. If `indexes.protocol` exists, also insert into the protocol-scoped SMT
- On `delete(tenant, messageCids)`:
  1. Look up each messageCid's stored indexes (need a reverse lookup, similar
     to current IndexLevel)
  2. Delete from global SMT
  3. If protocol-scoped, delete from protocol SMT

### 1.4 Replace `EventLog` references in handlers

Every handler that currently calls `eventLog.append()` or
`eventLog.deleteEventsByCid()` switches to `stateIndex.insert()` /
`stateIndex.delete()`:

| Handler | Current call | New call |
|---------|-------------|----------|
| `RecordsWriteHandler` (line 137) | `eventLog.append(tenant, messageCid, indexes)` | `stateIndex.insert(tenant, messageCid, indexes)` |
| `RecordsWriteHandler` (line 241) | `eventLog.deleteEventsByCid(tenant, cids)` | `stateIndex.delete(tenant, cids)` |
| `ProtocolsConfigureHandler` (line 69) | `eventLog.append(tenant, messageCid, indexes)` | `stateIndex.insert(tenant, messageCid, indexes)` |
| `ProtocolsConfigureHandler` (line 96) | `eventLog.deleteEventsByCid(tenant, cids)` | `stateIndex.delete(tenant, cids)` |
| `StorageController` (line 67) | `eventLog.append(tenant, messageCid, indexes)` | `stateIndex.insert(tenant, messageCid, indexes)` |
| `StorageController` (lines 188, 239) | `eventLog.deleteEventsByCid(tenant, cids)` | `stateIndex.delete(tenant, cids)` |

**Files modified:**
- `packages/dwn-sdk-js/src/dwn.ts` -- `DwnConfig`: replace `eventLog: EventLog` with `stateIndex: StateIndex`, update constructor, handler wiring, `open()`, `close()`
- `packages/dwn-sdk-js/src/store/storage-controller.ts` -- replace all `eventLog` references with `stateIndex`
- `packages/dwn-sdk-js/src/handlers/records-write.ts` -- replace `eventLog` field and calls
- `packages/dwn-sdk-js/src/handlers/protocols-configure.ts` -- replace `eventLog` field and calls
- `packages/dwn-sdk-js/src/handlers/messages-query.ts` -- see Phase 2

### 1.5 Remove EventLog

Delete or deprecate:
- `packages/dwn-sdk-js/src/types/event-log.ts`
- `packages/dwn-sdk-js/src/event-log/event-log-level.ts`
- `packages/dwn-sql-store/src/event-log-sql.ts` (replaced in Phase 3)
- Remove from `packages/dwn-sdk-js/src/index.ts` exports
- Update all test files that reference `EventLog` (see catalog in research)

---

## Phase 2: New Sync Protocol

### 2.1 Add `MessagesSync` DWN message type

This replaces `MessagesQuery` for sync purposes. The protocol is a multi-step
exchange where two nodes walk the SMT to identify differences.

Create `packages/dwn-sdk-js/src/interfaces/messages-sync.ts` and
`packages/dwn-sdk-js/src/handlers/messages-sync.ts`.

**Message types:**

```typescript
// Step 1: Root comparison
type MessagesSyncDescriptor = {
  interface: 'Messages';
  method: 'Sync';
  messageTimestamp: string;
  protocol?: string;           // optional protocol scope
  action: 'root' | 'subtree' | 'leaves';

  // For 'root': no additional fields
  // For 'subtree': request hash at a specific tree prefix
  prefix?: string;             // bit path, e.g. "0110101..."
  // For 'leaves': request leaf messageCids under a prefix
};

type MessagesSyncReply = {
  status: { code: number; detail: string };
  root?: Uint8Array;           // for 'root' action
  hash?: Uint8Array;           // for 'subtree' action
  entries?: string[];          // for 'leaves' action: messageCid[]
};
```

**Authorization:** Same model as `MessagesQuery` -- tenant can always sync their
own data, delegates need a permission grant with scope
`{ interface: Messages, method: Sync, protocol? }`.

**Handler implementation:**

```typescript
class MessagesSyncHandler implements MethodHandler {
  constructor(
    private didResolver: DidResolver,
    private messageStore: MessageStore,
    private stateIndex: StateIndex
  ) {}

  async handle({ tenant, message }): Promise<MessagesSyncReply> {
    // authenticate + authorize (same as MessagesQuery)
    const { action, protocol, prefix } = message.descriptor;

    switch (action) {
      case 'root':
        const root = protocol
          ? await this.stateIndex.getRoot(tenant, protocol)
          : await this.stateIndex.getRoot(tenant);
        return { status: { code: 200 }, root };

      case 'subtree':
        const hash = protocol
          ? await this.stateIndex.getSubtreeHash(tenant, prefix, protocol)
          : await this.stateIndex.getSubtreeHash(tenant, prefix);
        return { status: { code: 200 }, hash };

      case 'leaves':
        const leaves = await this.stateIndex.getLeaves(tenant, prefix);
        return { status: { code: 200 }, entries: leaves };
    }
  }
}
```

### 2.2 Register the handler

In `packages/dwn-sdk-js/src/dwn.ts`:

```typescript
this.methodHandlers = {
  ...existing handlers...
  [DwnInterfaceName.Messages + DwnMethodName.Sync]:
    new MessagesSyncHandler(didResolver, messageStore, stateIndex),
};
```

Add `Sync = 'Sync'` to `DwnMethodName` enum in
`packages/dwn-sdk-js/src/enums/dwn-interface-method.ts`.

### 2.3 Decide on `MessagesQuery`

**Option A (recommended): Keep MessagesQuery but reimplement on top of StateIndex.**

`MessagesQuery` may still be useful for non-sync use cases (e.g., an admin
querying "what messages exist for protocol X?"). We can reimplement the handler
to query the StateIndex's reverse lookup instead of the EventLog. This means
`MessagesQuery` returns an unordered set of messageCids matching the filters,
without cursor/watermark semantics.

The reply type simplifies:
```typescript
type MessagesQueryReply = {
  status: { code: number; detail: string };
  entries?: string[];      // messageCid[] (no guaranteed order)
  // cursor removed -- no longer needed
};
```

**Option B: Remove MessagesQuery entirely.**

If no external consumers need it, remove it. The sync engine no longer uses it.
The permission grants for `MessagesQuery` in `connect.ts` would be replaced with
`MessagesSync` grants.

**Recommendation:** Option A for now -- keep the handler but remove cursor/watermark
ordering. This is a smaller blast radius and preserves a useful diagnostic
capability. We can remove it later if it proves unnecessary.

### 2.4 Update permission scopes

In `packages/agent/src/connect.ts`, update the sync permission requests:

```typescript
// Before:
{ protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Query }

// After:
{ protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Sync }
```

Keep `MessagesRead` (still needed to fetch individual messages after diff).
Keep `MessagesQuery` if we keep it (Option A).

Add `MessagesSync` to the permission scope types in
`packages/dwn-sdk-js/src/types/permission-types.ts`.

---

## Phase 3: Rewrite Sync Engine in `agent`

### 3.1 New sync flow

Replace the contents of `packages/agent/src/sync-engine-level.ts` with:

```
sync(direction?) {
  for each registered identity (did, options):
    for each dwnUrl resolved from DID document:
      for each protocol (or global if protocols=[]):

        // Phase 1: Compare roots
        localRoot  = agent.dwn.processRequest(MessagesSync, action:'root', protocol?)
        remoteRoot = agent.rpc.sendDwnRequest(MessagesSync, action:'root', protocol?)

        if localRoot === remoteRoot:
          continue  // already in sync

        // Phase 2: Tree diff via subtree walk
        diff = walkTreeDiff(localRoot, remoteRoot, protocol?)
        // diff = { onlyLocal: string[], onlyRemote: string[] }

        // Phase 3: Pull missing messages (remote has, local doesn't)
        if (!direction || direction === 'pull'):
          pullMessages(did, dwnUrl, diff.onlyRemote, delegateDid?)

        // Phase 4: Push missing messages (local has, remote doesn't)
        if (!direction || direction === 'push'):
          pushMessages(did, dwnUrl, diff.onlyLocal, delegateDid?)
}
```

### 3.2 Tree diff protocol (`walkTreeDiff`)

```typescript
async walkTreeDiff(
  did: string,
  dwnUrl: string,
  protocol: string | undefined,
  delegateDid: string | undefined
): Promise<{ onlyLocal: string[], onlyRemote: string[] }> {

  const onlyLocal: string[] = [];
  const onlyRemote: string[] = [];

  // Recursive walk
  async function walk(prefix: BitPath) {
    const localHash  = await getLocalSubtreeHash(prefix, protocol);
    const remoteHash = await getRemoteSubtreeHash(prefix, protocol);

    if (bytesEqual(localHash, remoteHash)) return;  // subtrees match

    if (isLeafDepth(prefix)) {
      // At leaf level, fetch actual messageCids
      const localLeaves  = await getLocalLeaves(prefix, protocol);
      const remoteLeaves = await getRemoteLeaves(prefix, protocol);
      onlyLocal.push(...setDifference(localLeaves, remoteLeaves));
      onlyRemote.push(...setDifference(remoteLeaves, localLeaves));
      return;
    }

    // Recurse into children
    await walk(prefix + '0');
    await walk(prefix + '1');
  }

  await walk('');  // start from root
  return { onlyLocal, onlyRemote };
}
```

**Optimization:** The walk can be batched — request multiple subtree hashes in a
single round trip. This reduces the number of RPC calls from O(k * 256) to
O(k * 256 / batchSize). A practical optimization is to request hashes at
multiple depths in a single message (e.g., "give me hashes at depth 4 for all
16 prefixes").

### 3.3 Dependency-aware message processing

After the diff produces the set of missing messageCids, fetch them all via
`MessagesRead` and then process them in dependency order:

```typescript
async pullMessages(did, dwnUrl, missingCids, delegateDid?) {
  // Step 1: Bulk fetch all missing messages
  const messages = await Promise.all(
    missingCids.map(cid => fetchRemoteMessage(did, dwnUrl, cid, delegateDid))
  );

  // Step 2: Build dependency graph
  const graph = buildDependencyGraph(messages);
  // Dependencies:
  //   ProtocolsConfigure <- RecordsWrite with that protocol
  //   Parent record      <- Child record (via parentId)
  //   Initial write      <- Update write (same recordId, not initial)
  //   Permission grant   <- Record using that permissionGrantId

  // Step 3: Topological sort
  const sorted = topologicalSort(graph);

  // Step 4: Process in order
  for (const msg of sorted) {
    const reply = await agent.dwn.node.processMessage(did, msg.message, { dataStream: msg.data });
    if (!isSuccessful(reply)) {
      // Log warning -- dependency should have been satisfied by topo sort
      // If it fails, it means the dependency wasn't in the diff set
      // (already existed locally). Retry after all others are processed.
      retryQueue.push(msg);
    }
  }

  // Step 5: Retry any that failed (deps may have been in a different order)
  for (const msg of retryQueue) {
    await agent.dwn.node.processMessage(did, msg.message, { dataStream: msg.data });
  }
}
```

**Dependency graph construction:**

```typescript
function buildDependencyGraph(messages: DwnMessage[]): Graph {
  const graph = new Graph();
  const byRecordId = new Map();  // recordId -> initial write messageCid
  const byProtocol = new Map();  // protocol -> ProtocolsConfigure messageCid

  for (const msg of messages) {
    graph.addNode(msg.messageCid);

    if (msg.descriptor.interface === 'Protocols' && msg.descriptor.method === 'Configure') {
      byProtocol.set(msg.descriptor.definition.protocol, msg.messageCid);
    }

    if (msg.descriptor.interface === 'Records') {
      if (isInitialWrite(msg)) {
        byRecordId.set(msg.recordId, msg.messageCid);
      }
    }
  }

  for (const msg of messages) {
    // Protocol dependency
    if (msg.descriptor.protocol && byProtocol.has(msg.descriptor.protocol)) {
      graph.addEdge(byProtocol.get(msg.descriptor.protocol), msg.messageCid);
    }

    // Parent dependency
    if (msg.descriptor.parentId && byRecordId.has(msg.descriptor.parentId)) {
      graph.addEdge(byRecordId.get(msg.descriptor.parentId), msg.messageCid);
    }

    // Initial write dependency
    if (msg.descriptor.interface === 'Records' && !isInitialWrite(msg)) {
      if (byRecordId.has(msg.recordId)) {
        graph.addEdge(byRecordId.get(msg.recordId), msg.messageCid);
      }
    }

    // Permission grant dependency
    if (msg.authorization?.permissionGrantId && byRecordId.has(msg.authorization.permissionGrantId)) {
      graph.addEdge(byRecordId.get(msg.authorization.permissionGrantId), msg.messageCid);
    }
  }

  return graph;
}
```

### 3.4 Remove sync LevelDB sublevels

The following sublevels in `SyncEngineLevel` are no longer needed:

| Sublevel | Reason for removal |
|----------|--------------------|
| `cursors` | No more cursor-based pagination |
| `pushQueue` | No more queuing -- diff produces exact set, process immediately |
| `pullQueue` | Same |
| `history` | SMT root comparison replaces anti-echo. If roots match, we're in sync. |

The only sublevel that remains is `registeredIdentities`.

### 3.5 Update agent types

In `packages/agent/src/types/dwn.ts`:
- Add `DwnInterface.MessagesSync` enum value
- Add entries to `DwnMessage`, `DwnMessageDescriptor`, `DwnMessageParams`,
  `DwnMessageReply`, `MessageHandler`, `dwnMessageConstructors`

### 3.6 Update `connect.ts`

Replace `MessagesQuery` permission request with `MessagesSync`:

```typescript
// packages/agent/src/connect.ts, lines 228-241
requests.push({
  protocol,
  interface: DwnInterfaceName.Messages,
  method: DwnMethodName.Sync,        // was: DwnMethodName.Query
}, {
  protocol,
  interface: DwnInterfaceName.Messages,
  method: DwnMethodName.Read,        // unchanged
}, {
  protocol,
  interface: DwnInterfaceName.Messages,
  method: DwnMethodName.Subscribe,   // unchanged
});
```

---

## Phase 4: SQL Implementation + Server Wiring

### 4.1 `StateIndexSql` in `dwn-sql-store`

Create `packages/dwn-sql-store/src/state-index-sql.ts`:

**Tables:**

```sql
-- SMT nodes (internal + leaf)
CREATE TABLE stateIndexNodes (
  tenant    VARCHAR(255) NOT NULL,
  protocol  VARCHAR(200),          -- NULL for global tree
  nodeHash  BLOB NOT NULL,         -- hash of this node
  depth     INTEGER NOT NULL,
  prefix    VARCHAR(256) NOT NULL,  -- bit path
  leftHash  BLOB,                  -- NULL for leaves
  rightHash BLOB,                  -- NULL for leaves
  leafKey   BLOB,                  -- NULL for internal nodes
  leafCid   VARCHAR(60),           -- NULL for internal nodes
  PRIMARY KEY (tenant, protocol, nodeHash)
);

-- Root hash per tenant/protocol
CREATE TABLE stateIndexRoots (
  tenant   VARCHAR(255) NOT NULL,
  protocol VARCHAR(200) NOT NULL DEFAULT '',  -- '' for global
  rootHash BLOB NOT NULL,
  PRIMARY KEY (tenant, protocol)
);

-- Reverse lookup: messageCid -> protocol (for deletion)
CREATE TABLE stateIndexCidMeta (
  tenant     VARCHAR(255) NOT NULL,
  messageCid VARCHAR(60) NOT NULL,
  protocol   VARCHAR(200),
  PRIMARY KEY (tenant, messageCid)
);
```

### 4.2 Update `dwn-server` storage config

In `packages/dwn-server/src/storage.ts`:
- Replace `EventLog` factory logic with `StateIndex` factory logic
- Support `level://`, `sqlite://`, `mysql://`, `postgres://` backends
- Update `StoreType` enum: replace `EventLog` with `StateIndex`

In `packages/dwn-server/src/config.ts`:
- Replace `DWN_STORAGE_EVENTS` env var with `DWN_STORAGE_STATE_INDEX`
  (or keep the same env var with a deprecation note)

---

## Phase 5: Tests

### 5.1 New test files

| File | Tests |
|------|-------|
| `packages/dwn-sdk-js/tests/smt/sparse-merkle-tree.spec.ts` | Core SMT: insert, delete, root, proof, diff, empty tree, large tree, collision resistance |
| `packages/dwn-sdk-js/tests/state-index/state-index.spec.ts` | StateIndex interface tests (generic, shared between Level and SQL) |
| `packages/dwn-sdk-js/tests/state-index/state-index-level.spec.ts` | LevelDB-specific StateIndex tests |
| `packages/dwn-sdk-js/tests/handlers/messages-sync.spec.ts` | MessagesSync handler: auth, root comparison, subtree queries, leaf queries |
| `packages/agent/tests/sync-engine-level.spec.ts` | Rewrite: SMT-based sync, dependency ordering, tree diff, pull/push with topo sort |

### 5.2 Updated test files

Every test file that currently creates an `EventLog` instance needs to create a
`StateIndex` instead. This is primarily a search-and-replace in the test setup
code (`beforeEach` / `afterEach` blocks). See the full catalog above for the
list of ~20 test files in dwn-sdk-js and ~5 in api/agent.

---

## Phase 6: Cleanup

- Remove `packages/dwn-sdk-js/src/types/event-log.ts`
- Remove `packages/dwn-sdk-js/src/event-log/` directory
- Remove `packages/dwn-sql-store/src/event-log-sql.ts` and related types
- Remove `PaginationCursor` type (or keep if used by `RecordsQuery` -- check)
- Remove watermark/ULID dependencies from the state index path
- Update `packages/dwn-sdk-js/src/index.ts` exports
- Remove `MessagesQuery` handler if we go with Option B in Phase 2.3
- Remove sync-related LevelDB sublevels from agent test harness
- Update `packages/agent/src/test-harness.ts`: replace `dwnEventLog` with
  `dwnStateIndex`

---

## Implementation Order

```
Phase 1.1  SMT core data structure + tests          (no existing code changes)
Phase 1.2  StateIndex interface                      (new file only)
Phase 1.3  StateIndexLevel implementation + tests    (new files only)
Phase 1.4  Replace EventLog in handlers              (modify existing files)
Phase 1.5  Remove EventLog                           (delete files, update exports)
Phase 2.1  MessagesSync message type + handler       (new files)
Phase 2.2  Register handler in Dwn                   (modify dwn.ts)
Phase 2.3  Simplify/keep MessagesQuery               (modify handler)
Phase 2.4  Update permission scopes                  (modify connect.ts, types)
Phase 3.1  Rewrite sync engine                       (modify sync-engine-level.ts)
Phase 3.2  Tree diff protocol                        (new code in sync engine)
Phase 3.3  Dependency-aware processing               (new code in sync engine)
Phase 3.4  Remove old sync sublevels                 (modify sync engine)
Phase 3.5  Update agent types                        (modify types/dwn.ts)
Phase 3.6  Update connect.ts                         (modify connect.ts)
Phase 4.1  StateIndexSql                             (new file in dwn-sql-store)
Phase 4.2  Server config                             (modify dwn-server)
Phase 5    Tests                                     (new + modified test files)
Phase 6    Cleanup                                   (delete old files)
```

Phases 1.1-1.3 can proceed without modifying any existing code.
Phase 2.1 can proceed in parallel with Phase 1.4.
Phase 3 depends on Phase 1 and Phase 2.
Phase 4 can proceed in parallel with Phase 3.
Phase 5 runs continuously alongside each phase.
Phase 6 runs last.

---

## Open Questions

1. **Batch subtree queries**: Should `MessagesSync` support requesting multiple
   prefixes in a single message? This would reduce round trips during tree diff
   from O(k * depth) to O(k * depth / batchSize). Recommend yes, with a
   `prefixes: string[]` array field.

2. **Protocol-scoped vs global trees**: Should we maintain both? The global tree
   enables "are we fully in sync?" in one comparison. Protocol-scoped trees
   enable selective sync. Recommend: always maintain the global tree; maintain
   protocol trees only for identities registered with specific protocols.

3. **MessagesQuery retention**: Keep it (Option A) or remove it (Option B)?
   Recommend keeping for now as a diagnostic/query tool, but removing
   cursor/watermark semantics.

4. **Tree compaction**: The SMT stores intermediate nodes. When doing many
   inserts/deletes, orphaned nodes accumulate. Should we implement periodic
   compaction, or does the SMT implementation handle this via hash-based
   deduplication?

5. **Initial tree population**: When a DWN starts for the first time against an
   existing MessageStore (migration scenario), the StateIndex needs to be
   populated from all existing messages. Implement a
   `StateIndex.rebuild(messageStore)` method for this.

6. **Remote-to-remote sync**: This architecture naturally supports it -- two
   DWN servers can exchange `MessagesSync` messages directly. However, the
   authorization model needs thought: who signs the `MessagesSync` request
   when there's no user agent involved? This is a future concern.
