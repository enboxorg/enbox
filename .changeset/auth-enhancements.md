---
"@enbox/auth": minor
---

Add `lock()`, `switchIdentity()` sync registration, and `onPasswordRequired` callback

- **`AuthManager.lock()`**: New top-level method that stops sync, clears the active session, locks the vault, and transitions to `'locked'` state. Session storage markers are preserved so `restoreSession()` can reconnect after unlock.
- **`switchIdentity()` sync registration**: Now calls `sync.registerIdentity()` for the target identity before starting sync, ensuring imported or newly-switched identities are properly registered for DWN synchronization.
- **`onPasswordRequired` callback**: New optional callback on `RestoreSessionOptions` that is invoked when the vault is locked and a password is needed. This enables interactive password prompts (PIN dialogs, CLI prompts) without pre-supplying a password.
