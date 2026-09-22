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

Each normalized link has two domain-qualified progress tokens:

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

There is deliberately no third terminal/dead-letter ledger. A broad `Invalid`,
authorization failure, retry count, elapsed time, or malformed retained payload
does not prove that skipping a signed source entry is safe. Such entries remain
visible sparse work until they settle or an explicit rebuild resets the source
before purging them.

## Page-forward invariant

Every root before a committed page cursor has exactly one durable disposition:

| Direction | Success | Unsettled but retained |
| --- | --- | --- |
| Pull | Materialized in the local DWN | Exact-source quarantine row |
| Push | Accepted/duplicate/superseded at that endpoint | Delivery obligation |

The sparse rows and handled-through token commit in one Level batch. A single
root therefore cannot block the rest of its page when the engine can durably
retain what remains owed.

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

Each direction has one serialized loop. A live turn consumes one requested page
and tries one due sparse receipt; a covering turn repeats pages until drain and
then gives consecutively successful sparse work one bounded pass. Pull and push
remain independent, so a blocked push cannot stop pull. Commit operations use a
short cross-context link lock, reread the latest link record, reject stale
lifetimes/domains, and preserve the opposite direction's progress.

Network work is capped at two operations per normalized endpoint. The gate
opens a short in-memory circuit after a connection failure, so already queued
links are deferred without adding a persisted endpoint scheduler. Failed
subscription establishment remains unsubscribed and is retried by the next
ordinary refresh; successful reconnect clears the circuit and forces catch-up
over the socket.
This bounds an outage to a small probe count instead of multiplying it by the
number of protocols, contexts, or identities at that endpoint.

Subscriptions are wake signals. Establishment and reconnect always schedule a
page from durable progress; a cursorless subscription is never treated as
coverage. A wake arriving during work remains as trailing work.

A bounded in-memory echo cache is shared across link sessions but scoped by
tenant, CID, and endpoint. Pulling a CID suppresses an immediate push back to
that endpoint without suppressing fan-out to another endpoint. A recent push
only narrows a local lookup: pull skips re-admission after verifying the exact
local message still exists and that a current `RecordsWrite` still has its
body. Cache loss merely permits an idempotent duplicate apply; cache state is
never durable progress.

## Retry, settlement, and purge

- **Settle:** success or a verified complete duplicate deletes the sparse row.
- **Retry:** stop at the first unresolved receipt. Eligibility is derived from
  the row's persisted attempt time/count and optional `Retry-After`; wakes,
  manual operations, and the periodic pass provide retry opportunities without
  per-receipt timers.
- **Rebuild:** reset the affected checkpoint to zero before removing sparse
  rows, then replay the current authorized source.
- **Remove:** deleting an identity or accepted followed context is explicit
  owner intent and removes the sparse state that only that owner can recover.

Push is rebuildable while the local feed exists. Pull is rebuildable only while
an authorized remote retains the source. If no source remains, the quarantine
row may be the only recoverable copy and must not be silently purged.

Corrupt or unreadable encrypted quarantine follows the same rule. Ordinary
retry backs it off and leaves it visible. `rebuildRemoteDirection()` is the
explicit disaster-recovery path: it refuses an incomplete target plan or a
missing current source, resets every current checkpoint for the logical target,
then purges quarantine and replays. Vault lock prevents a commit that needs
encryption; the engine never falls back to plaintext.

## Covering operations

Incremental live work consumes bounded pages. Public operations whose existing
contract promises coverage—`sync()`, identity recovery, followed-context
refresh, and endpoint drain—drive the same page primitive from the durable
watermark until a page reports `drained: true`. Every page returns to the
runtime before another is requested, so an active feed cannot monopolize a
link, direction, or endpoint.

They resolve only when their documented materialization/delivery conditions are
met. Otherwise they reject or return an explicit incomplete result; one-page
success is never silently substituted for covering success. Subscriptions are
opened before catch-up, and a wake received during a page remains trailing
work. A continuously growing feed can therefore keep a covering call active,
but cannot prevent other work from progressing; no snapshot-style query head
is part of the base design.

## Temporary legacy/next coexistence

Exactly one engine is selected when an agent is created:

```text
legacy | next
```

One agent instance runs exactly one engine, and the engines never share
checkpoint namespaces. Next uses `syncNextV1/*`; switching modes therefore
rescans from its own state and needs no dual writes or checkpoint translation.
The temporary selector does not yet prevent two independently constructed
agents over the same profile from choosing different modes concurrently. Hosts
must keep that configuration consistent; cross-context mode exclusion remains
a cutover gate before next can become the default.

The selector is forwarded by `AuthManager` and `ConnectionStore`, so a real
dapp can compare engines without constructing a private agent. Next owns the
small shared registration/followed-context catalog directly; it does not
instantiate the legacy transfer engine as a hidden control plane.

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
- explicit checkpoint-reset/rescan recovery.

## Abstraction budget

- The local DWN and handled-through tokens are the success records.
- Persist only sparse quarantine and delivery obligations.
- Keep query/classify, commit, and retry functions separate and short.
- Share an abstraction only when it owns a real lifetime/invariant or removes
  substantial duplicated code.
- Do not introduce a repair mode, materializer service, dependency graph,
  persisted transient scheduler, or global transport scheduler.
- Do not weaken DWN admission to make a test or partially received message pass.

## Adversarial review record

The first complete stack was reviewed against the execution model rather than
its class names. The following defects were found and fixed before proposing a
cutover:

- requeued page handlers could retain one executor drain instead of yielding;
- a retry requested during an operation lost its delay and became a hot loop;
- pending work was initially eligible only after feed drain and could starve or
  deadlock its own capacity limit;
- covering runs rejected non-inline bodies without first giving their retained
  sparse obligations one finite retry;
- pull and push I/O shared one whole-link serializer;
- pulled CIDs echoed back to their source endpoint;
- established-socket requests carrying cancellation/deadlines fell back to
  HTTP, and aborting one request could not remove only its response waiter;
- non-drained replies could repeat a cursor forever;
- sequential subscription establishment let one bad endpoint delay healthy
  links;
- incomplete discovery could have been mistaken for proof that an existing
  link disappeared;
- quarantine left by a retired endpoint was not serviced through another
  authorized binding for the same logical target;
- deleting sparse recovery state and resetting its checkpoint were separate
  crash windows;
- concurrent public `sync()` callers queued duplicate covering waves instead
  of sharing one merged follow-up;
- covering work and convergence probes were unbounded across logical targets
  sharing one endpoint;
- endpoint drain initially relied on one fingerprint observation, persisted a
  pre-aborted endpoint, and could skip non-live session cleanup on failure;
- observer exceptions could escape into replication, while messages admitted
  later from quarantine had no delivery event.
- every successful materialization scanned the complete central quarantine
  separately instead of settling all page CIDs in one sparse scan;
- a covering run retried only one of several healthy streamed obligations;
- terminal subscription errors left a link permanently marked subscribed;
- equivalent endpoint spellings created distinct durable links;
- next still constructed the complete legacy engine for catalog operations;
- corrupt quarantine had an internal reset primitive but no safe replay entry
  point.

Regression coverage now includes delayed retry ownership, continuous-feed
pending fairness, concurrent same-link directions, non-advancing cursors,
cross-endpoint quarantine settlement, atomic rebuild, pooled-socket request
cancellation, broad `Invalid` outcomes remaining non-terminal, and replay after
apply-before-ledger crashes. Public one-shot callers now coalesce into at most
one merged follow-up, independent endpoints remain concurrent, and covering
page turns interleave behind the endpoint gate so target count cannot become an
HTTP burst or let one continuously active target starve its peers. Drain
requires two unchanged fingerprint observations before success and rechecks
cancellation or topology between phases.

The corrective pass retains one bounded pass over consecutively successful
sparse work, normalized link identity, transactional subscription pairs with
terminal-drop reporting, direct catalog ownership with one structured
cross-context wake channel, and reset-before-purge rebuild. Quarantine remains
sparse and is scanned once for all materialized CIDs in a page instead of
maintaining a fourth durable index. Transport-disconnect notifications mark
currentness stale without launching an HTTP query; reconnect or the periodic
backstop requests catch-up.

The real-transport matrix covers the four required dapp modes, wake-only live
updates, non-inline bodies followed by independent tiny roots, one offline and
one healthy exact link, and isolated legacy/next comparison. A 579-root unit
fixture proves six watermark-driven remote page queries without point reads.

### Deliberate remaining boundaries

- Legacy remains the default. `next` is opt-in until the stacked reviews and CI
  complete.
- Followed-source acceptance currently reuses the established catalog ceremony;
  replica transfer and all next-engine checkpoints remain isolated. The
  multi-binding/revocation redesign is still a separate security slice.
- Owner-authorized historical import remains a separate security protocol and
  is not hidden inside page classification.
- Terminal classification is intentionally conservative: uncertain or broad
  `Invalid` outcomes stay sparse/retryable until a typed allowlist proves
  permanence.
- Constructor-time selection prevents two engines in one agent. Cross-context
  legacy-versus-next exclusion must be solved before changing the default.
- Per-endpoint network work is capped at two operations. Page pumps return to
  the endpoint queue after every turn, so a continuously growing target cannot
  retain the endpoint indefinitely. Change that small fixed concurrency only
  from measured workloads, not by returning to unbounded transport fan-out.
- Drain cancellation is cooperative between committed pages, exact-link runs,
  and drain phases. Local admission and an in-flight request are never
  preempted halfway through; the next page is not requested after cancellation.
- The next engine currently emits registration, durable checkpoint, and fresh
  delivery events used by application readiness/data refresh. The legacy
  repair/quota lifecycle event vocabulary still needs a consumer audit before
  next becomes the default; it must not be mechanically recreated as another
  state machine without a demonstrated consumer.
