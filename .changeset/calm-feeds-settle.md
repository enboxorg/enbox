---
'@enbox/agent': patch
---

Reuse complete local feed snapshots and acknowledged page progress so a later retryable push does not replay the settled prefix to the same remote. Keep current RecordsWrite payload-read failures retryable and release unused streams when acknowledged entries are skipped.
