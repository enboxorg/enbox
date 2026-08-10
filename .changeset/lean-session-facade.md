---
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/cli": patch
---

Remove the duplicate `Enbox` connect, refresh, and disconnect lifecycle. `ConnectionStore` now owns session lifecycle orchestration and closes the session-bound `Enbox` data facade automatically.
