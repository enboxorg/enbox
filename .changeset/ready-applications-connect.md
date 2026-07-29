---
"@enbox/api": minor
"@enbox/browser": minor
---

Let connection stores own an application manifest. Registered protocols are
projected into delegated connect, refresh, and opted-in auto-refresh flows, and
each restored or newly established session completes protocol readiness before
the store publishes it as connected. Readiness failures now fail closed, with
missing or incompatible wallet protocol configurations surfaced through the
existing wallet-reapproval state.
