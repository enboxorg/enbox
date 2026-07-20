---
"@enbox/agent": patch
---

refactor: sync engine readability and vocabulary. Corrected stale and inverted comments, removed dead bookkeeping, split the 244-line engine constructor into named factories, and unified the subsystem vocabulary to one name per concept and one meaning per word (glossary in `docs/architecture/sync-vocabulary.md`).

BREAKING: the `SyncEngine` dead-letter read API is renamed to match the `DeadLetterEntry` type it returns and the vocabulary the store and every collaborator already used — `getFailedMessages` → `getDeadLetters`, `clearFailedMessage` → `clearDeadLetter`, `clearAllFailedMessages` → `clearAllDeadLetters`.

Fixed: a paused replication link reported `converged: true` from a reconcile cycle that compared nothing, so post-repair verification could emit `reconcile:completed` for a link it never checked. The reconcile result now carries `paused` and leaves `converged` absent when nothing was verified.
