---
'@enbox/api': patch
'@enbox/browser': patch
---

Add `RecordView.whenUsable()` to await the first state containing records or an authoritative ready-empty result, with caller abort and view-lifecycle cleanup.
