---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

fix: commit latest-state transitions atomically in the message store and resolve retained initial writes by stable entry ID

`RecordsWrite` and `RecordsDelete` previously stored the new latest message and demoted the retained initial write as two separate store mutations, so concurrent Query/Read/Subscribe could observe two latest-state rows for one record and crashed resolving the initial write through the mutable `isLatestBaseState:false` index — aborting sync. The message store now exposes `commitLatestState`, which applies the insert, retained demotions, and displaced deletions as one atomic commit (a single Level batch / SQL transaction) guarded by a conflict check: a plan built from state that a concurrent commit has since changed is rejected inside the store's lock/transaction, and the write and delete paths re-read, re-validate the winner, and re-plan. Readers resolve retained initial writes by the stable identity `entryId === recordId` in one batched lookup; an update whose initial write is genuinely missing (store corruption) is omitted from Query/Subscribe snapshots with a warning, and RecordsRead returns a typed 500.
