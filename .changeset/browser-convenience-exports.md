---
"@enbox/browser": patch
---

feat(browser): re-export common symbols so dapps need fewer packages

`@enbox/browser` now re-exports the handful of symbols dapps most commonly
reached into sibling packages for, so that in most cases a dapp only needs
`@enbox/browser` (plus `@enbox/protocols` for shared protocol definitions):

- `TypedRecord` (from `@enbox/api`)
- `BrowserStorage`, `ProviderAuthParams`, `ProviderAuthResult` (from `@enbox/auth`)
- `DwnInterface` (from `@enbox/agent`)
- `DateSort`, `DwnInterfaceName`, `DwnMethodName`, `ProtocolDefinition`,
  `ProtocolActionRule` (from `@enbox/dwn-sdk-js`)

These are additive re-exports; anything more specialized is still available by
importing the underlying package directly.
