---
"@enbox/api": patch
---

Default store-owned AuthManager local identity sync to the application's manifest protocol URIs, including when restoring a session. Explicit scopes and caller-owned managers retain their existing behavior. Restoration reapplies the store default, so persistent broader scopes belong in identitySyncProtocols on the store configuration.
