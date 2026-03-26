---
"@enbox/agent": patch
---

fix: don't retry permanent push failures (400/401/403)

Prevents infinite retry loop for protocol-scoped singleton records
(profile, avatar, hero, wallet) that get 400 RecordLimitExceeded from
the remote. PushResult now distinguishes transient vs permanent failures.
