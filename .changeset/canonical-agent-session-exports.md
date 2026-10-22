---
"@enbox/auth": patch
"@enbox/api": patch
"@enbox/browser": patch
---

Use the canonical AgentSession class and AgentSessionIdentity type throughout authentication and connection APIs. Re-export both directly through auth and browser entrypoints, removing the AuthSession and IdentityInfo aliases and the intermediate wallet grant-processing re-export.

Remove obsolete delegate cache keys, single-object retry compatibility, forwarding-only lifecycle helpers, and the internal delegate-state wrapper. Reject unreadable retry journals and invalid persisted sessions without erasing their evidence.

Persist each session's complete owner/delegate binding and revocation metadata in one atomic record, replacing the separate restoration and identity markers. Journal replaced delegates' revocations under their original binding, retain their signing keys for retry, and reject journal overflow before replacing valid persisted state. Preserve matching restored sessions' revocation metadata while refresh approvals replace it.

Preserve another context's current approval when a stale manager disconnects. Resolve restore and headless identity preferences from the same canonical record. Complete journal-proven interrupted teardown before disconnect, restore maintenance, or public retry can consume its durable intent.

Preserve successful fresh approvals while retrying older grants for the same delegate. Treat retry evidence as current disconnect intent only when it contains the current approval's complete revocation map.
