---
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/cli": patch
---

Remove the duplicate `Enbox` connect, refresh, and disconnect lifecycle. `ConnectionStore` now owns session lifecycle orchestration and closes the session-bound `Enbox` data facade automatically. Stores either own the `AuthManager` they create or borrow an explicitly supplied manager; caller-owned agents must be wrapped in a caller-owned manager.
