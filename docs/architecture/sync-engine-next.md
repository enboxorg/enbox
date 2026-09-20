# Sync engine next

Status: implementation contract for the temporary `SyncEngineNext` PR stack.

Parent design work: [#1722](https://github.com/enboxorg/enbox/issues/1722) and
[#1727](https://github.com/enboxorg/enbox/issues/1727).

## Goal

Replace the legacy repair/reconcile state machine with one page-based replication
engine whose durable state answers two questions for every exact remote link:

1. How far has each source feed been durably handled?
2. Which sparse inputs or deliveries still need an outcome?

The local DWN remains the authoritative set of locally materialized messages.
Successful remote deliveries are compressed by link progress. The engine does
not persist duplicate "accepted" or "sent-accepted" lists.

## Exact link

Every link is isolated by:

```text
tenant DID + normalized endpoint + canonical projection ID + authorization epoch
```

Each link has two domain-qualified progress tokens:

- `pullHandledThrough`: every remote-feed entry through the token was
  materialized, quarantined, or given a precise terminal outcome.
- `pushHandledThrough`: every local-feed entry through the token was delivered,
  retained as an endpoint-specific delivery obligation, or given a precise
  terminal outcome.

These are handled-through tokens, not claims that every sparse obligation is
complete.

## Sparse durable state

### Inbound quarantine

The central quarantine store owns exact-source rows. "Central" means one store
and lifecycle owner, not one row that merges authority from different remotes.

A quarantine row identifies its exact link and source position, but also keeps a
stable logical target so locally materializing the CID can settle duplicate
receipts from other links. It stores an encrypted, versioned envelope containing
only the received input required after the pull token advances.

### Outbound delivery obligations

A delivery obligation is exact-link state containing a local source position,
message CID, and typed retry outcome. It does not duplicate the message or body:
the local DWN feed is the durable source.

This sparse ledger allows a large attachment or a retryable remote failure to
remain owed while later independent local roots continue to the same endpoint.

### Terminal outcomes

Only enumerated, evidence-backed outcomes are terminal. Time, retry count,
generic HTTP status, missing support, wrong transferred bytes, resolver outage,
or the broad `Invalid` replication result are not terminal by themselves.

## Page-forward invariant

Every root before a committed page cursor has exactly one durable disposition:

| Direction | Success | Retryable | Permanent |
| --- | --- | --- | --- |
| Pull | Materialized in the local DWN | Exact-source quarantine row | Precise terminal outcome |
| Push | Accepted/duplicate/superseded at that endpoint | Delivery obligation | Precise terminal outcome |

The sparse rows, terminal outcomes, and handled-through token commit in one
Level batch. A single root therefore cannot block the rest of its page when the
engine can durably retain what remains owed.

A page must stop without advancing when the engine cannot assume that
responsibility—for example, stale authority, cancellation, failed encryption,
pending-capacity exhaustion, or storage failure. Advancing in those cases would
be data loss rather than liveness.

## Runtime shape

The implementation is organized around six small operations:

```text
consumePullPage          retryQuarantineEntry
commitPullPage

consumePushPage          retryDeliveryObligation
commitPushPage
```

Feed consumption and sparse retry are independently eligible. At most one page
operation and one retry operation per direction/link run at once. Pull and push
network waits do not share a whole-link execution lock. Commit operations use a
short cross-context link lock, reread the latest link record, reject stale
lifetimes/domains, and preserve the opposite direction's progress.

Subscriptions are wake signals. Establishment and reconnect always schedule a
page from durable progress; a cursorless subscription is never treated as
coverage. A wake arriving during work remains as trailing work.

## Retry, settlement, and purge

- **Settle:** success or a verified complete duplicate deletes the sparse row.
- **Terminalize:** replace the sparse row with a precise permanent outcome.
- **Abandon:** explicit user intent records an abandoned terminal outcome; it
  never silently claims success.
- **Rebuild:** reset the affected checkpoint before the earliest removed
  obligation (or safely to zero), remove the sparse rows, and replay the source.

Push is rebuildable while the local feed exists. Pull is rebuildable only while
an authorized remote retains the source. If no source remains, the quarantine
row may be the only recoverable copy and must not be silently purged.

Corrupt or unreadable encrypted quarantine follows the same rule: quarantine
the corruption and reset/rescan when possible. Vault lock prevents a commit
that needs encryption; the engine never falls back to plaintext.

## Covering operations

Incremental live work consumes bounded pages. Public operations whose existing
contract promises coverage—`sync()`, identity recovery, followed-context
refresh, and endpoint drain—must capture a finite source head and drive the
same page primitive until that head is handled.

They resolve only when their documented materialization/delivery conditions are
met. Otherwise they reject or return an explicit incomplete result; one-page
success is never silently substituted for covering success.

## Temporary legacy/next coexistence

Exactly one engine is selected when an agent is created:

```text
legacy | next
```

The engines never run concurrently for the same profile and never share
checkpoint namespaces. Next uses `syncNextV1/*`. Switching engines stops and
fences the active runtime, then the selected engine safely rescans from its own
state. No dual writes or checkpoint translation are required.

Apples-to-apples comparison uses cloned deterministic fixtures. Running one
engine and then the other against the same mutable remotes is not a comparison,
because the first run changes the inputs.

Legacy code is deleted after next passes the comparison matrix and becomes the
default. The mode switch and legacy namespace are temporary migration tools,
not permanent product surface.

## Required application modes

Every stack layer must preserve these four modes:

1. **Fresh dapp and fresh protocol:** local and remotes contain little or no
   data. Empty feeds establish progress without unnecessary reads or writes.
2. **New dapp over an existing protocol:** remote history page-catches into an
   empty/new local replica without per-CID reads.
3. **Existing dapp catches up and publishes:** remote-unique and local-unique
   roots converge independently; pending input or delivery does not hide the
   independent tail.
4. **Existing dapp hydrates a new empty remote:** local history reaches the new
   endpoint, including required bodies, while pull and other links remain live.

## Comparison matrix

The reusable scenario runner executes legacy and next separately from identical
local/remote snapshots and fault scripts. It records:

- final local and remote fingerprints;
- link progress and sparse obligations;
- HTTP requests and WebSocket methods/frames;
- repeated CIDs and transferred bytes;
- time to first usable local view;
- independent-note and tiny-delta latency;
- restart and recovery outcome.

Required fault scenarios include:

- 579-entry cold pull from two remotes;
- mostly duplicate replicas with unique tails;
- missing body followed by an independent note;
- continuous feed while old quarantine becomes recoverable;
- quarantine at capacity;
- one remote offline while another progresses;
- a large attachment before a tiny independent delta;
- stalled push while same-link pull continues;
- crash before/after apply and before/after the ledger batch;
- restart with sparse obligations;
- vault lock/unlock and corrupt quarantine ciphertext;
- reconnect with a missed event and no later write;
- generic authorization failure versus proven immutable invalidity;
- authorization-epoch replacement;
- sparse selected context in a large unrelated tenant;
- explicit abandon and checkpoint-reset/rescan recovery.

## Abstraction budget

- The local DWN and handled-through tokens are the success records.
- Persist only sparse quarantine, delivery, and terminal outcomes.
- Keep query/classify, commit, and retry functions separate and short.
- Share an abstraction only when it owns a real lifetime/invariant or removes
  substantial duplicated code.
- Do not introduce a repair mode, materializer service, dependency graph,
  persisted transient scheduler, or global transport scheduler.
- Do not weaken DWN admission to make a test or partially received message pass.
