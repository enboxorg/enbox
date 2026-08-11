---
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/api": patch
---

Replace separate sync identity registration and update operations with an idempotent options setter, atomic routing refreshes, cross-context registration wakes, and idempotent removal.
