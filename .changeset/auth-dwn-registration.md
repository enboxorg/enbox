---
"@enbox/auth": minor
---

Add DWN registration support to all connection flows

- Expand `RegistrationOptions` with provider-auth callbacks (`onProviderAuthRequired`, `registrationTokens`, `onRegistrationTokens`)
- Add `ProviderAuthParams`, `ProviderAuthResult`, and `RegistrationTokenData` types
- Create `registerWithDwnEndpoints()` flow supporting provider-auth-v0 (with token refresh) and PoW fallback
- Wire registration into `connect()`, `walletConnect()`, `importFromPhrase()`, and `importFromPortable()` flows
- Add `@enbox/dwn-clients` as a dependency for `DwnRegistrar`
- Add `rpc.getServerInfo` mock to test helper
- 17 new tests covering all registration paths, 99.68% line coverage
