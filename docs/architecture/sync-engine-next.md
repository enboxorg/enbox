# Watermark sync ledger

Status: durable ledger, bounded pull and push pages, and explicit one-row retry
primitives. The replacement runtime and public engine selection are still to be built.

## Purpose

The local DWN is the record of successfully materialized messages. The ledger
stores only two kinds of transfer state for each exact remote link:

1. A `pullHandledThrough` and `pushHandledThrough` feed token. Each token means
   every earlier source entry has been handled or retained for retry.
2. Sparse receipts for work still owed: inbound quarantine and
   endpoint-specific outbound delivery obligations.

Successful messages do not need a second durable accepted or sent list. The
watermarks compact their successful prefixes; the sparse receipts preserve
exceptions after a page moves forward.

## Exact links and source receipts

An exact link is identified by tenant DID, normalized endpoint, projection ID,
and authorization epoch. A new lifetime ID distinguishes a recreated link with
the same exact key. Its pull and push tokens are independent. A source
receipt adds the source stream ID, epoch, position, and message CID, so repeated
delivery of one CID at a new feed position remains distinct work.

Retirement and deletion check the lifetime before removing an exact link, so
stale cleanup cannot remove a replacement with the same key.

Ordinary page commits require the link snapshot taken before the feed query and
advance beyond its exact prior token. An exact empty replay succeeds without
a write; any other stale or same-position page cannot mutate the link or
rewrite its cursor. Commits compare the page's exact source receipts with its
successful and retained dispositions. Every returned entry must be accounted
for. The feed may advance over filtered
positions without returning entries at those positions.

A token-domain change requires a reset; accepting one as ordinary progress
could skip unseen source entries.

## Atomic page progress

`commitPullPage()` writes its handled-through token together with new or
settled quarantine receipts in one Level batch. `commitPushPage()` does the
same for delivery obligations. Ledger mutations share one cross-context lock,
so reset cannot interleave with a page commit. Each commit rereads its link and
preserves the other direction's token; network work remains outside the lock.

The ledger validates source-token domains, positions, CIDs, and mutually
exclusive page dispositions before writing. One page cannot assign different
CIDs to the same source position. When a cursor names a CID, that CID must
identify the page entry at the cursor's position. It checks a
tenant-wide hard bound on quarantine receipts and serialized entry size before
advancing progress, including rows retained after a link retires. At that hard
resource boundary, any page needing more quarantine stops before advancement.
A failed validation, capacity check, or batch leaves the previous token in
place.

## One-page pull intake

One pull invocation queries at most 100 remote feed roots after the link's
durable token. It captures every raw source receipt before classification,
verifies feed-root CIDs and inline record data for the entire page, and then
admits roots using only received or already-local support. Known feed-root
dependencies are ordered before their dependents, including a parent whose
completion moved behind its child. Missing bodies and dependencies not resolved
from feed roots enter quarantine without point reads; the retry slice must
demonstrate their eventual convergence. A successful reply without an entries
array, cursor, or boolean `drained` value is rejected before admission.
CID recomputation proves byte integrity; normal DWN admission still owns signer
and authorization validation.

Every returned root is either settled or retained in quarantine before the
page token advances. A later independent root in the same page is still
processed. The primitive returns after this one commit; pagination,
quarantine retry, wake handling, and scheduling remain runtime concerns.

## Sparse recovery state

Quarantine retains a structured clone of the received feed entry needed to
retry a pull after the page token advances. The ledger binds it to its exact
source position and CID, records its serialized UTF-8 size, and rejects an
oversized or mismatched row. Quarantine uses the same trusted local-profile
storage boundary as the local DWN; it is not a separate secret store. At-rest
confidentiality, if required, must cover the complete local profile rather
than only this recovery queue. Remote mode may place the ledger and local DWN
in separate stores; both remain inside that accepted trust boundary.

Ledger scans validate only queue routing metadata and the stored size needed
for resource accounting. Retry must validate the retained message and data
again before DWN admission.

No production runtime wrote the earlier encrypted row format. The first pull
commit for an existing exact link checks quarantine owned by that exact key and
rejects an encrypted row with instructions to clear the complete next-engine
ledger. Quarantine retained under a retired link is checked when recovery reads
that central queue; a different replacement link advances independently.

An outbound obligation retains the source receipt, retry outcome, optional
record ID, and whether the feed entry was latest when retained. It does not
duplicate the message or body; a later delivery attempt reads those from the
local DWN. Removing an obsolete link retires its outbound obligations while
preserving inbound quarantine that another authorized link for the same
logical target may still resolve. Retired rows count toward the tenant quota;
they are not purged merely because endpoint discovery temporarily loses a
binding. Explicit tenant removal clears them.

Full reset clears link checkpoints before sparse rows, so an interrupted reset
cannot retain a checkpoint after deleting the work it covers.

## One-row quarantine retry

For an ordinary owner or delegate target, one explicit retry call selects the
oldest retained row for a tenant and projection, validates its stored receipt,
message CID, and inline data, then reuses normal dependency admission. It
attempts one root, performs no catch-up pagination of its own, and does not
schedule itself or purge failed rows. Pending and failed attempts advance their
timestamp so another row gets the next turn, including when attempts land
within the same millisecond.

This slice recovers ordinary owner and delegated roots. A latest data-bearing
write is removed only after a genuinely fresh apply; Duplicate or Superseded
remains pending until the later local-completion-proof slice can establish that
the record is queryable. Applying a dataless, non-latest write also leaves its
receipt pending for a later body-bearing receipt. A retry settles only its
selected root CID: dependencies applied along the way never clear their own
quarantine receipts as a side effect. Role-authorized rows also remain pending
for the separate exact-or-newer role-support slice. These conservative outcomes
keep the queue safe while those authority-specific proofs are reviewed
separately.

## One-page push intake

One push invocation queries at most 100 local feed entries for one exact link.
It reuses the dependency-aware remote apply path and advances the push token
only after every returned receipt is acknowledged or retained as an outbound
obligation. A record-local failure leaves that receipt pending while independent
entries continue; a link-wide or endpoint-wide failure stops further requests
and retains the rest of the page. When a current record event is handled, the
same atomic commit also settles older same-record obligations through that
source position for this exact link.

## One-row delivery retry

One explicit retry selects the oldest outbound obligation for an exact link and
reads its message and data from the local DWN by CID. A write that was latest
when retained still requires its body; a non-latest initial write may be sent
without data as ancestry. A verified remote acknowledgement settles only that
endpoint's receipt. Failure updates its outcome and attempt time so another row
can be tried next. Settlement checks the link lifetime and selected attempt,
preventing a stale retry from changing a replacement link or newer retry state.
If a crash follows remote acknowledgement but precedes ledger settlement, the
next attempt safely replays the message. This primitive owns no timer.

A handled current RecordsWrite or RecordsDelete covers older receipts for the
same record and exact link. Coverage is bounded by source-token domain and
position, so it cannot settle a later mutation or another endpoint's work. This
lets a newer update settle an intermediate update that the local DWN has already
pruned. A current RecordsWrite still requires its body before it can create this
coverage; a dataless duplicate alone does not prove it.

Retry scheduling, subscriptions, catalog, and runtime cutover belong to later
stack layers. They must preserve this ledger contract when deciding whether a
source entry is handled or owed.
