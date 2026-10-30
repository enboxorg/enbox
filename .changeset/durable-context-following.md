---
"@enbox/api": patch
---

Persist shared-context following choices in private encrypted protocol records and
restore them through the existing context APIs across devices. Propagate explicit
forget and leave decisions without treating temporary owner unavailability as a
forget. Keep membership authority and acceptance fencing local to each device.
Allow saved choices to be forgotten by owner and context ID when access is no
longer available, and preserve newer choices that the current app cannot restore.
