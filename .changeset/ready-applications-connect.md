---
"@enbox/api": minor
"@enbox/browser": minor
---

Let connection stores own a non-empty application manifest. Its protocols are
the sole typed source for delegated connect, refresh, and opted-in auto-refresh
flows, while plain stores continue to require explicit refresh protocols. Each
restored or newly established session completes readiness before the store
publishes it as connected. Owner sessions require local installation by default
and can opt into blocking hosted publication; delegate failures fail closed,
with missing or incompatible wallet configurations surfaced through the
existing wallet-reapproval state.
