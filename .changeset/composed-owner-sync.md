---
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/api": patch
---

Resolve application owner sync scopes through module dependencies and retained configuration history, preserving explicit scopes and delegate grants. Restore hosted providers before a cold connection can install packaged configurations, and make explicit sync wait for in-flight link initialization. Add end-to-end coverage for encrypted composition, delegation, offline replay, and live recovery.
