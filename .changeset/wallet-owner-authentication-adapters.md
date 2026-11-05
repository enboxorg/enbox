---
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/browser": patch
"@enbox/cli": patch
---

Add owner-authentication approval and relay/popup client adapters without creating a DWN delegate session. Combined Connect approval can return a transaction-bound owner proof alongside explicitly requested grants, while verifying the requester origin independently of display metadata.

Expose the authentication types and error through the auth and browser entrypoints. Delegation-only client, handler, and modal options accept only connect or refresh request modes; identity-only authentication uses its dedicated entrypoint.
