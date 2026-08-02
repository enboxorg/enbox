---
'@enbox/api': patch
'@enbox/browser': patch
'@enbox/dwn-sdk-js': patch
---

Make typed record deletion idempotent when the record is already absent or an equal or stronger tombstone already satisfies the delete. Preserve role-authorized tombstone state so a context-bound prune can still displace a plain delete.
