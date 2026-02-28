---
"@enbox/auth": minor
---

Support custom agent, vault, and local DWN strategy in AuthManager.create()

- Add `agent`, `agentVault`, and `localDwnStrategy` options to `AuthManagerOptions`
- When a pre-built `Web5UserAgent` is provided, it is used as-is (escape hatch for custom DWN stores)
- Re-export `Web5UserAgent` and `HdIdentityVault` classes from `@enbox/agent` so consumers don't need a direct dependency
- Re-export `LocalDwnStrategy` type
- 5 new tests covering all custom agent creation paths, 169 total tests passing
