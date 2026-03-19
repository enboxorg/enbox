---
"@enbox/auth": patch
---

fix(auth): remove redundant sync pull from importDelegateAndSetupSync

The manual `sync('pull')` call was immediately followed by
`startSyncIfEnabled()` which runs its own immediate sync cycle.
This doubled the startup burst and could trigger 429 rate limits
on the remote DWN server.
