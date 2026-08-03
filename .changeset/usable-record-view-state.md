---
'@enbox/api': patch
'@enbox/browser': patch
---

Give observable views one lifecycle contract through `ready()` and async `close()`, while `RecordView.current` reports replication freshness separately from local usability.
