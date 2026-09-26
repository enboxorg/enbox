# Watermark sync ledger

Status: durable storage foundation for the proposed watermark sync engine. This
slice does not select or run a new sync engine.

## Purpose

The local DWN is the record of successfully materialized messages. The ledger
stores only two kinds of transfer state for each exact remote link:

1. A `pullHandledThrough` and `pushHandledThrough` feed token. Each token means
   every earlier source entry has been handled or retained for retry.
2. Sparse receipts for work still owed: encrypted inbound quarantine and
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
tenant-wide hard bound on quarantine receipts and encrypted size before
advancing progress, including rows retained after a link retires. At that hard
resource boundary, any page needing more quarantine stops before advancement.
A failed validation, capacity check, or batch leaves the previous token in
place.

## One-page pull intake

One pull invocation queries at most 100 remote feed roots after the link's
durable token. It captures every raw source receipt before classification,
verifies message CIDs and inline record data for the entire page, and then
admits roots using only received or already-local support. Missing bodies and
dependencies do not trigger point reads during intake.

Every returned root is either settled or encrypted into quarantine before the
page token advances. A later independent root in the same page is still
processed. The primitive returns after this one commit; pagination,
quarantine retry, wake handling, and scheduling remain runtime concerns.

## Sparse recovery state

Quarantine retains the received input needed to retry a pull after the page
token advances. The vault encrypts that input and binds it to its exact link,
source position, and CID. The codec rejects oversized input and refuses to
decrypt a row under a different receipt or while the vault is locked. The
encrypted feed entry's sequence must match the bound source position.

An outbound obligation retains the source receipt and retry outcome. It does
not duplicate the message or body; a later delivery attempt reads those from
the local DWN. Removing an obsolete link retires its outbound obligations
while preserving inbound quarantine that another authorized link for the same
logical target may still resolve. Retired rows count toward the tenant quota;
they are not purged merely because endpoint discovery temporarily loses a
binding. Explicit tenant removal clears them.

Full reset clears link checkpoints before sparse rows, so an interrupted reset
cannot retain a checkpoint after deleting the work it covers.

The pull and push page processors, retry scheduling, subscriptions, catalog,
and eventual runtime cutover belong to later stack layers. They must preserve
this ledger contract when deciding whether a source entry is handled or owed.
