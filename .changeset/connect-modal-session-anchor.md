---
"@enbox/browser": patch
---

feat(browser): connect modal owns the whole session — phone-first QR, pairing code, popup fallback

`enbox.connect()` in the browser now drives the entire wallet handshake from a
single modal instead of handing off to a wallet-selector-then-popup sequence:

- **Phone-first by default.** The modal immediately mints a relay request and
  shows a QR code for the user's phone wallet (a tappable deep link on mobile).
  The pairing-code prompt, success, denial, timeout, and error states all render
  in the same surface — no window juggling.
- **Popup still one click away.** "Use this browser instead" runs the existing
  popup flow, opened synchronously inside the click so popup blockers stay
  quiet. The last successful method + wallet are remembered (`localStorage`)
  and pre-selected next time; a remembered popup choice renders a prompt and
  never auto-opens a window.
- **Wallet switching stays in place.** A footer disclosure lists the wallet
  catalog and accepts a custom wallet URL, validated against the wallet's
  `/.well-known/enbox-connect` document (same machinery as
  the former standalone selector, which this replaces). Switching wallets re-mints the
  request for the new wallet.
- New exports: `runConnectModal`, `discoverWalletConnectServerUrl`,
  `runRelayConnect` (relay handshake with interactive pairing-code retry),
  `fetchWalletWellKnown`, and a dependency-free QR encoder
  (`encodeQr`/`qrToSvg`, byte mode, ECC M, versions 1–10).
- `EnboxConnectOptions` gains `preferredMethod`, `rememberChoice`,
  `connectServerUrl`, and `relayWalletPath`.

Removed: `showWalletSelector` and `WalletSelectorOptions`. The connect modal
is the single connect surface; its wallet switcher absorbs the selector's
quick-connect, favicon/letter-badge tiles, search filter, and
well-known-validated custom URL (with explicit override). The discovery
helpers stay public, now from `ui/wallet-well-known`: `fetchWalletWellKnown`,
`probeWalletWellKnown`, `WALLET_WELL_KNOWN_PATH`, `WalletWellKnownDocument`.
