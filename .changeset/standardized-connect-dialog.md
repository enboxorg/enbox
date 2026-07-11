---
"@enbox/browser": minor
---

feat(browser): redesign the wallet connect dialog

`showWalletSelector` (used by `BrowserConnectHandler`, so every dapp gets it by
default) is now a single modal with three zones:

- **Quick connect** — one-tap connect with the recommended (first) wallet.
- **Wallet grid** — a scrollable grid of wallet tiles with a search filter.
  Tiles render the wallet's own favicon (`/favicon.svg|ico|png`) and fall back
  to a letter badge. The previous third-party favicon proxy (which 404'd for
  most wallet origins and leaked the wallet URL) is removed.
- **Custom URL** — pasted wallet URLs are validated against the wallet's
  `/.well-known/enbox-connect` discovery document before the selection
  resolves, with an explicit override when verification is inconclusive.

New exports for dapps building their own dialog: `probeWalletWellKnown`,
`WALLET_WELL_KNOWN_PATH`, and the `WalletSelectorOptions` type (which lets
callers inject a custom validator). The `showWalletSelector(wallets)` call
signature is unchanged; the options argument is optional.
