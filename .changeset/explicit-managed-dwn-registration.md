---
"@enbox/auth": patch
---

Add explicit managed-owner DWN tenant registration with shared provider authorization, structured partial failures, concurrent-request coalescing and encrypted credential merging. Make encrypted token persistence the default, remove plaintext token storage helpers and fallback, and stop registering existing or foreign-owner tenants during unlock/import/recovery. Requested creation-time and replacement registration failures reject instead of silently continuing.

Remove duplicate success/failure callbacks and unused persisted token-exchange URL metadata. Caller-owned token persistence callbacks are awaited. Lifecycle changes and failed connection attempts cancel pending registration work, preventing later credential writes and tenant registration.
