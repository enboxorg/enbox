---
"@enbox/agent": patch
---

Allow identity sync removal to require an expected delegate, draining that delegate's local runtime and followed-context signing before key deletion while preserving a concurrent replacement's durable registration, quota, and runtime. Keep delayed activation fenced after removal and preserve explicit follow and pull operations while sync is stopped.
