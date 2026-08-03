---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/browser': patch
---

Fence followed-context role-policy and establishment across lifecycle changes, report not-yet-propagated membership as retryable, and make owner membership mutations reflect their effective roster after partial cleanup. Owned context catalogs now enumerate nested context roots through their parent contexts, and context-bound deletes no longer accept an endpoint-local miss after authority was established.
