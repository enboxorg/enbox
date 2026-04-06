---
"@enbox/browser": patch
---

fix: export showWalletSelector, fix portableIdentity type to PortableIdentity

- Export `showWalletSelector` from `@enbox/browser` so apps can use the Shadow DOM wallet picker directly for custom connect flows (e.g. identity export)
- Fix `DWebConnectClientOptions.portableIdentity` type from `PortableDid` to `PortableIdentity` to match what the wallet's `agent.identity.import()` expects
- Add integration test for all browser package re-exports
