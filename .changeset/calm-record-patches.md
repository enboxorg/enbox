---
'@enbox/api': patch
'@enbox/browser': patch
'@enbox/dwn-sdk-js': patch
---

Add a typed `records.patch(path, recordId, patchOrProducer)` operation that re-reads and retries once after a canonical DWN ordering conflict. Bound shared contexts read from the source authority and verify the accepted role before each attempt.
