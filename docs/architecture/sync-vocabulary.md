# Sync engine vocabulary

The sync subsystem (`packages/agent/src/sync-*.ts`) spans ~14k lines across 45
files, and several of its core concepts had accumulated multiple names while
several words had accumulated multiple meanings. This file is the canonical
list: **one name per concept, one meaning per word.**

If you add code here, use these names. If you find a synonym, it is a bug in
the code, not an entry missing from this table.

## One name per concept

| Concept | Canonical name | Retired aliases |
|---|---|---|
| The periodic pass that reconciles durable feeds *and* re-initializes orphaned links | **settle check** — `runSettleCheck`, `SETTLE_CHECK_TIMER` | `runLiveIntegrityCheck`, `SYNC_INTERVAL_TIMER` |
| The connectivity-driven recovery check: skips links whose replication stream is current (`isStreamCurrent`, both directions), reconciles stale links on their mailbox lanes under identity task supervision — endpoint-grouped like a full run — and falls back to a full verifying `sync()` only when a target has no active controller. Runs under the exclusive sync admission: deferred behind a lock owner, never dropped. No orphan re-init. | **convergence check** — `runConvergenceCheck`, `scheduleConvergenceCheck` | `runIntegrityCheck`, `scheduleIntegrityCheck` |
| Reconciling one target's durable feeds | **`reconcileTarget`** | `syncTargetWithDurableFeeds` |
| Runtime identifier of a replication link | **`linkKey`** — `buildLinkKey`, `LINK_KEY_SEPARATOR` | `buildLinkId`, `LINK_ID_SEPARATOR` |
| Endpoint-independent link identity | **`durableLinkIdentityKey`** | — |
| Durable replication-link store | **`replicationLinkStore`** — `getReplicationLinkStore` | `getLinkStore`, "ledger" (nickname only) |
| Per-link pull ordering fence | **`pullGeneration`** / `expectedPullGeneration` | `pullEpoch`, `openGeneration`, `expectedGeneration`, `subscriptionPullEpoch` |
| Target-plan version | **`topologyGeneration`** / `expectedTopologyGeneration` | bare `generation`, `expectedGeneration` |
| Per-link push batching state | **`pushQueue`** — `SyncPushQueueState/Params/Entry` | `pushRuntime`, `SyncPushRuntime*` |
| In-flight delivery acknowledgement, both directions: `track*Delivery` issues a delivery tag in feed order, `ack*Delivery` resolves it, and `commitAcked*Deliveries` advances the durable checkpoint through the contiguous acked prefix (cumulative ack); `pruneCoveredPushDeliveries` sweeps ledger positions a reconciler checkpoint covers | **delivery tag** — `SyncPullDeliveryTag`, `SyncPushDeliveryTag` | `SyncPullDeliveryTicket`, `startPullDelivery`, `commitPullDelivery`, `advanceContiguousPullCommits` |
| Folding a push result into quota state | **`applyPushResult`** | `transitionPushResult` |
| Permanently-failed message record | **dead letter** — `DeadLetterEntry`, `getDeadLetters`, `clearDeadLetter`, `clearAllDeadLetters`, `recordDeadLetter`, `hasDeadLetter` | `getFailedMessages`, `clearFailedMessage`, `clearAllFailedMessages`, `hasAdmissionDeadLetter` |
| Clearing one exact `(tenant, cid, remote)` dead letter | **`clearDeadLetterForTenant`** | the quota ops key `clearFailedMessage`, which shared a name with the across-tenants public method |
| A cycle that did not run because the link is parked | **`paused`** on the reconcile result | reporting `converged: true` for a link nothing compared |

## One meaning per word

| Word | Means, and only this | Not this |
|---|---|---|
| **epoch** | A durable, string-valued generation: `authorizationEpoch` on a link, `ProgressToken.epoch` on a remote stream | The in-memory pull counter — that is a *generation* |
| **generation** | An in-memory monotonic counter. Always qualified: *pull* generation, *topology* generation | The `SyncRuntime` lifetime — that is a *runtime* |
| **runtime** | The `SyncRuntime` timer-ownership scope for one start/stop cycle | Push batching state (*queue*), live-sync mode (*live sync*), or loose ephemeral state |
| **drain** | The engine's data handoff to an endpoint: `drainTo`, `SyncDrainCoordinator` | Pumping a request set (`runRequestedPasses`), advancing a commit prefix (`commitAckedPullDeliveries`), running repair passes (`runPendingRepairs`) |
| **admission** | Replicated-message admission into the local DWN: `admitClosure`, `admitRemoteFeedPage`, `MAX_ADMISSION_PASSES` | Background-task admission — that is *intake* (`pauseTaskIntake`) |
| **closure** | One root message plus the transitive dependency set required to make it applicable | Scope closure — always spelled out as *scope closure* |
| **scope** | A `SyncScope` (a protocol set) | The runtime timer scope, or the lock namespace (`_lockNamespace`) |
| **shared** | One execution coalesced across many callers (`enqueueShared`) | A pending-pass mark — that is `requestPass` / `isPassRequested` |

## Verb conventions

| Verb | Use for |
|---|---|
| `get*` | Cheap accessor or a single store read |
| `resolve*` | A lookup that requires derivation. **Never** "dismiss" |
| `build*` | Pure construction from parts |
| `compute*` | Hash / deterministic derivation |
| `collect*` | Full enumeration into a set |
| `query*` / `fetch*` | A DWN round-trip |
| `apply*` | Fold an outcome into state |
| `cancel*` | Retract a scheduled timer (suffix `Timer`) |
| `clear*` | Wipe durable storage |
| `dispose*` | Irreversibly end an owned lifetime (`SyncRuntime`, `SyncLinkController`) |
| `stop*` | Halt a restartable activity |
| `remove*` / `delete*` | Drop one entry from a registry or store |
| `prune*` | Supersession sweep |

Booleans are `is*` / `has*`; `should*` is reserved for policy predicates passed
downward (`shouldContinue` — `true` means *proceed*).

## Teardown verbs

One verb per kind of ending, because these had four overlapping spellings:

| Verb | Ends | Example |
|---|---|---|
| `dispose` | An owned lifetime, irreversibly | `SyncRuntime.dispose`, `SyncLinkController.dispose` |
| `close` | One external resource | `closeLiveSubscription`, `SyncEngineLevel.close` |
| `stop` | A restartable activity | `stopSync`, `stopLiveSync` |
| `cancel*Timer` | A scheduled timer | `cancelTimer`, `cancelRepairRetryTimer` |
| `clear` | Durable storage, wiped | `clear()`, `clearSyncDb` |
| `remove` / `delete` | One entry in a registry or store | `removeLinkController` |
| `prune` | A supersession sweep | `pruneStaleLinkBlocks` |
| `retire` | An attempt abandoned mid-flight | `retireFailedLinkAttempt` |

`teardown*` and `cleanup*` are retired — they were synonyms of `stop` and
`retire` respectively.

## Known remaining split

One knowingly-unconverged name, because the fix costs more than the confusion:

- **`SyncTarget.did` / `.dwnUrl`** are the same values as
  `ReplicationLinkState.tenantDid` / `.remoteEndpoint`, and `syncTargetFromLink`
  is purely that mapping. Converging them means per-site judgment across ~500
  occurrences — `did` and `dwnUrl` are also fields on the push-request and
  push-queue types — including ~149 untyped test literals the compiler cannot
  check, and 33 `as any` stubs where a wrong rename fails silently rather than
  loudly. Documented on the type instead.
