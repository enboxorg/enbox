---
"@enbox/agent": patch
"@enbox/auth": patch
---

fix: stop sync before revoking session grants and park links on revoked/expired authorization

Disconnect revoked delegated grants while live sync still ran under them, so the engine treated the self-inflicted 401s as repairable failures — error stacks and pointless retries on every successful delegate disconnect. AuthManager.disconnect() now stops sync first (revocation delivery is direct RPC and unaffected), and SyncEngineLevel classifies GrantAuthorizationGrantRevoked/GrantAuthorizationGrantExpired/MessagesSubscribeDeliveryAuthorizationFailed as terminal: the link parks (paused) with one concise log line instead of repair-retrying, which also quiets wallet-initiated revocation while a tool is running.
