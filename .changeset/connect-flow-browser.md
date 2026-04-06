---
"@enbox/browser": minor
---

feat: re-export api/auth from browser, update wallet defaults, add DWebConnect app metadata

- Re-export `Enbox`, `defineProtocol`, `repository` from `@enbox/api` and `AuthManager`, `AuthSession`, connect types from `@enbox/auth` so browser dapps need only a single `@enbox/browser` import
- Update `DEFAULT_WALLETS` to `enbox-wallet.pages.dev` and `blue-enbox-wallet.pages.dev` with description field
- Add `appName`, `appIcon`, and `portableIdentity` to the DWeb Connect postMessage protocol for richer wallet consent screens and identity export flows
- Add `description` field to `WalletOption` interface, rendered in the wallet selector modal
