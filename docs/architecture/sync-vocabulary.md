# Sync engine vocabulary

The sync subsystem (`packages/agent/src/sync-*.ts` plus
`packages/agent/src/types/sync.ts`) spans more than 13k lines across more than
40 source files. Several core concepts had accumulated multiple names while
several words had accumulated multiple meanings. This file is the canonical
list: **one name per concept, one meaning per word.**

If you add code here, use these names. If you find a synonym, it is a bug in
the code, not an entry missing from this table.

## One name per concept

| Concept | Canonical name | Retired aliases |
|---|---|---|
| The periodic pass that reconciles durable feeds *and* re-initializes orphaned links | **settle check** — `runSettleCheck`, `SETTLE_CHECK_TIMER` | `runLiveIntegrityCheck`, `SYNC_INTERVAL_TIMER` |
| Browser online and visibility recovery, which probes the transport; verified reconnection reopens cursorless wake subscriptions and requests durable passes from persisted checkpoints | **wake health check** — `checkHealth`, `checkAllConnections` | agent-level convergence or integrity check |
| Reconciling one target's durable feeds | **`reconcileTarget`** | `syncTargetWithDurableFeeds` |
| Runtime identifier of a replication link | **`linkKey`** — `buildLinkKey`, `LINK_KEY_SEPARATOR` | `buildLinkId`, `LINK_ID_SEPARATOR` |
| Endpoint-independent link identity | **`durableLinkIdentityKey`** | — |
| Durable replication-link store | **`replicationLinkStore`** | `getLinkStore`, `ledger` |
| Authoritative in-engine owner of one active link object, both wake subscriptions, its link executor, replication generation, repair, and reconciliation | **replication session** — currently `SyncLinkController` | independent live and reconciler link copies |
| Per-link subscription and reconciliation fence — ONE generation for the subscription pair and link executor | **`replicationGeneration`** / `expectedReplicationGeneration` | `pullGeneration`, `pullEpoch`, `openGeneration`, `expectedGeneration`, `subscriptionPullEpoch` |
| Target-plan version | **`topologyGeneration`** / `expectedTopologyGeneration` | bare `generation`, `expectedGeneration` |
| Deterministic identity of one tenant-and-scope projection, independent of endpoint and authorization | **`projectionId`** — `computeProjectionId` | endpoint identity, authorization identity |
| Sole serializer for work owned by one active replication session | **link executor** — `SyncLinkExecutor` | link mailbox, direction reconciliation queue, `enqueueDirection`, `enqueueShared` |
| Runtime-owned scheduling for one active replication session | **link scheduler** — `SyncRuntime.armTimeout` / `armTimeoutIfEarlier`, keyed by `syncRepairRetry:<linkKey>` or `syncReconcile:<linkKey>` | controller timer handles, due-time fields, `set*Timer` / `consume*Timer` pairs |
| Runtime-owned Retry-After scheduling before a replication session exists | **link initialization retry** — `scheduleLinkInitRetry`, keyed by `linkInitRetry:<linkKey>` | link scheduler, which requires an active replication session |
| Coalesced notice that one durable wake pass is owed | **work mark** — `SyncLinkExecutor.request`, `hasPending` | event cursor, `requestPass`, `_requestedPasses` |
| Distinct caller-specific operation serialized by the active replication session | **executor call** — `SyncLinkExecutor.enqueue`, `SyncLinkRecoveryCoordinator.execute` | work mark, shared operation |
| Whether ordinary executor work may run for the current replication generation; wakes are retained while ineligible and calls fail fast | **executor eligibility** — `isReady`, `markReady`, `SyncLinkRecoveryCoordinator.resume`, surfaced as `isReplicationReady` / `markReplicationReady` | readiness promise, replication readiness barrier, parked administrative call |
| Cursorless remote subscription whose events request durable pull passes | **live pull subscription** — `openLivePullSubscription`, `LivePullWakeContext` | live-pull admission pipeline, `SyncLivePullProcessor` |
| A remote subscription event that says the durable remote feed may have advanced; bursts request one trailing pass, and the pass always resumes from `link.pull.contiguousAppliedToken` | **durable pull wake** — `executor.request('pull')` followed by `SyncLinkRecoveryCoordinator.resume` when eligible | per-event admission, delivery acknowledgement, event-cursor checkpoint, or EOSE checkpoint |
| Whether the active replication session has established its pull baseline and every accepted durable pull wake is covered by a completed pass | **pull currentness** — `isPullCurrent`, `markPullPending`, `markPullCurrent`, `pull:currentness-change` | transport connectivity, feed convergence, link status, or checkpoint progress |
| A local subscription event or transport-reconnected notification that says the durable local feed may have advanced; bursts request one trailing pass, and the pass always resumes from `link.push.contiguousAppliedToken` | **durable push wake** — `executor.request('push')` followed by `SyncLinkRecoveryCoordinator.resume` when eligible | per-event push job, delivery acknowledgement, or checkpoint evidence |
| Durable resume point for one direction of one replication link | **direction checkpoint** — `DirectionCheckpoint.contiguousAppliedToken` | delivery acknowledgement, arbitrary subscription cursor |
| Namespace in which progress-token positions can be compared | **token domain** — exact `(streamId, epoch)` pair | stream alone, epoch alone, or a globally ordered position |
| Folding a push result into quota state | **push result outcome** — `applyPushResult`, `SyncQuotaPushResultOutcome` | `transitionPushResult`, push transition |
| Temporarily unadmittable remote root that must hold the pull page | **deferred pull** — `SyncDeferredPullState`, `SyncDeferredPullStore` | dead letter, retryable push failure |
| Endpoint-local, bounded hint that prevents immediate transfer echoes | **echo suppression** — `SyncEchoSuppressor` | checkpoint evidence, durable acknowledgement |
| Active durable record of a remote quota rejection | **quota block** — `SyncQuotaBlockState` without `supersededAt` | dead letter, generic retryable failure |
| Direct retry of a due quota block, independent of feed progress | **quota probe** — `probeQuotaBlocksForTarget`, `probeBlocksForTarget`, `probeBlock` | repair pass |
| Historical quota row retained only to explain an intentional feed omission | **resolved quota omission** — `SyncQuotaBlockState.supersededAt` | active quota block |
| Backend-neutral owner of quota policy and durable quota state | **quota manager** — `SyncQuotaManager`, injected directly into its policy consumers | engine quota delegation wrappers |
| Verified comparison of complete local and remote feed inventories | **feed convergence** — `SyncFeedConvergenceManager` | ordinary reconciliation pass, transport health |
| Ordering and supervision of start/stop, exclusive work, and background tasks | **lifecycle coordination** — `SyncLifecycleCoordinator`, `SyncTaskGroup` | timer ownership, which belongs to `SyncRuntime` |
| Public engine observability notification | **sync event** — `SyncEvent`, `SyncEngine.on(listener)` | DWN subscription `MessageEvent`, transport lifecycle message |
| Dependency-aware topological ordering of messages before DWN processing | **admission order** — `orderMessagesForAdmission` | feed order, direction reconciliation order |
| Permanently-failed message record | **dead letter** — `DeadLetterEntry`, `getDeadLetters`, `clearDeadLetter`, `clearAllDeadLetters`, `recordDeadLetter`, `hasDeadLetter` | `getFailedMessages`, `clearFailedMessage`, `clearAllFailedMessages`, `hasAdmissionDeadLetter` |
| Clearing one exact `(tenant, cid, remote)` dead letter | **`clearDeadLetterForTenant`** | the quota ops key `clearFailedMessage`, which reused the across-tenants public method's name |
| A cycle that did not run because the link is parked | **`paused`** on the reconcile result | reporting `converged: true` for a link nothing compared |

## One meaning per word

| Word | Means, and only this | Not this |
|---|---|---|
| **epoch** | A durable, string-valued generation: `authorizationEpoch` on a link, `ProgressToken.epoch` on a remote stream | The in-memory replication counter — that is a *generation* |
| **generation** | An in-memory monotonic counter. Always qualified: *replication* generation, *topology* generation | The `SyncRuntime` lifetime — that is a *runtime* |
| **runtime** | The `SyncRuntime` timer owner for one start/stop cycle | Link execution state (*executor*), live-sync mode (*live sync*), or loose ephemeral state |
| **settle** | Reach a quiescent boundary: a **settle check** reconciles durable feeds, while `SyncTaskGroup.settle` and `SyncRunCoordinator.settle` wait for owned work to finish | A quota probe or transport health check |
| **drain** | Consuming ordered queued/data work: `SyncLinkExecutor.drain`, `drainTo`, `SyncDrainCoordinator` | Committing a durable checkpoint or naming a reconciliation pass |
| **admission** | Replicated-message admission into the local DWN: `admitClosure`, `admitRemoteFeedPage`, `MAX_ADMISSION_PASSES` | Background-task admission — that is *intake* (`pauseTaskIntake`) |
| **closure** | One root message plus the transitive dependency set required to make it applicable | Scope closure — always spelled out as *scope closure* |
| **scope** | Always qualified data selection: *sync scope* (`SyncScope`) or emitted *event scope* (`SyncEventScope`) | The runtime or lock namespace (`_lockNamespace`) |
| **shared** | One execution and result joined by several callers, such as the queued `sync()` follow-up in `joinPendingSyncRun` | A work mark or distinct caller-specific executor call |

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
| `cancel*` | Retract runtime-owned scheduling without ending its owner; name the cancellation scope |
| `clear*` | Wipe durable storage |
| `dispose*` | Irreversibly end an owned lifetime (`SyncRuntime`, `SyncLinkController`) |
| `stop*` | Halt a restartable activity |
| `remove*` / `delete*` | Drop one entry from a registry or store |
| `prune*` | Supersession sweep |

Booleans are `is*` / `has*`; `should*` is reserved for policy predicates passed
downward (`shouldContinue` — `true` means *proceed*).

### Scheduling cancellation scopes

| Scope | Entry point |
|---|---|
| One exact runtime key | `SyncRuntime.cancelTimer` |
| A runtime key family selected by predicate | `SyncRuntime.cancelTimers` |
| Reconciliation and repair scheduling for one `linkKey` | `SyncLinkRecoveryCoordinator.cancelScheduledWork` |
| Active-session scheduling plus pre-session initialization retries for one identity | `SyncEngineLevel.cancelIdentityTimers` |
| Every timer owned by one runtime | `SyncRuntime.dispose` |

## Teardown verbs

One verb per kind of ending, because these had four overlapping spellings:

| Verb | Ends | Example |
|---|---|---|
| `dispose` | An owned lifetime, irreversibly | `SyncRuntime.dispose`, `SyncLinkController.dispose` |
| `deactivate` | An active owner's callback eligibility before resource disposal | `SyncLinkController.beginDeactivation`, `SyncLinkController.deactivate` |
| `close` | One external resource | `closeLiveSubscription`, `SyncEngineLevel.close` |
| `stop` | A restartable activity | `stopSync`, `stopLiveSync` |
| `cancel*` | Runtime-owned scheduling at a named scope | `cancelTimer`, `cancelScheduledWork`, `cancelIdentityTimers` |
| `clear` | Durable storage, wiped | `clear()`, `clearSyncDb` |
| `remove` / `delete` | One entry in a registry or store | `removeLinkController` |
| `prune` | A supersession sweep | `pruneStaleLinkBlocks` |
| `retire` | An attempt abandoned mid-flight | `retireFailedLinkAttempt` |

`teardown*` and `cleanup*` identifiers are retired — they were synonyms of
`stop` and `retire` respectively.

## Subsystem boundaries

These mechanisms deliberately solve different failure modes. Combining them
would make one signal stand in for proof it does not carry.

| Subsystem | Owns | Does not own |
|---|---|---|
| Quota | `SyncQuotaManager` owns durable per-link blocks, backoff, direct probes, and resolved-omission evidence; the engine owns lifecycle fencing and effects | General push retry, dead letters, or feed checkpoints |
| Deferred pulls | Temporary pull-admission state; a root holds the page until it succeeds, disappears, or ages into a dead letter | Push failures or permanent admission rejection |
| Echo suppression | Short-lived `(tenant, CID, endpoint)` transfer hints | Durable progress; a cache hit never advances a checkpoint by itself |
| Feed convergence | Verified inventory/fingerprint mismatch policy after reconciliation | Socket health or routine feed transfer |
| Pull currentness | Ephemeral per-replication-session evidence that no accepted remote-feed wake remains uncovered | Durable checkpoint state, socket health, or equality of complete feed inventories |
| Lifecycle coordination | Transition serialization, exclusive sync ownership, task intake, and waiting for supervised work | Timers and liveness, which belong to the current runtime |
| Sync events | Metrics/UI-facing observations emitted by the engine | Transport subscription delivery or replication control flow |
| Admission ordering | Dependency order within a closure before DWN admission | Executor arrival order or durable-feed page order |

## Checkpoint and token-domain rules

- Compare token positions only when both `streamId` and `epoch` match. A token
  from another domain is neither newer nor older.
- Advance a direction checkpoint only after a durable-feed page has settled,
  or establish its initial baseline from equal paired-subscription snapshots.
  A subscription event cursor or EOSE cursor is never checkpoint evidence.
- Reset or re-establish the baseline when the token domain changes. Never carry
  a position across domains.
- Validate a persisted direction checkpoint before its first query. Reset an
  invalid token and rebuild the baseline from durable feed inventory.

## Design rule: verify at the point of use

Trusting a cached or claimed state instead of verifying the property where it
is used is this subsystem's recurring bug shape — a stale `isConnected`
preferred over proving liveness, a subscription event cursor treated as
durable progress, a fingerprint match treated as feed identity beyond
its domain coverage. The check is almost always cheap and local: an on-demand
transport health probe, replay from the persisted direction checkpoint, or a
fail-closed decision when a domain set is known-incomplete. When a property
matters, verify it where it is consumed; never assume it from provenance.

## Known remaining splits

Names left knowingly unconverged, because the fix costs more than the confusion:

- **`SyncLinkController`** is the replication session. The existing name stays
  because renaming it adds broad churn without changing or clarifying its
  ownership boundary.

- **`SyncTarget.did` / `.dwnUrl`** are the same values as
  `ReplicationLinkState.tenantDid` / `.remoteEndpoint`, and `syncTargetFromLink`
  is purely that mapping. Converging them requires per-site judgment across
  roughly 500 occurrences — `did` and `dwnUrl` are also fields on push-request
  types — including roughly 149 untyped test literals the compiler cannot
  check and 33 dynamic `as any` stubs where a wrong rename fails silently.
  Measured July 2026; documented on the type instead.
