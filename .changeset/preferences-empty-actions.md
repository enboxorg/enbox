---
"@enbox/protocols": patch
"@enbox/dwn-sdk-js": patch
---

fix(protocols): drop empty `$actions` arrays that the DWN rejects at configure time

The `ProtocolRuleSet` JSON schema declares `minItems: 1` for `$actions`, so a
rule set carrying `$actions: []` is rejected at `protocols.configure()` time with
`/$actions: must NOT have fewer than 1 items`. `PreferencesDefinition` declared
`$actions: []` on all four of its rule sets (`theme`, `locale`, `privacy`,
`notification`), which made the Preferences protocol impossible to install.

- `@enbox/protocols`: `PreferencesDefinition` now omits `$actions` entirely.
  Omitting the directive — not passing an empty array — is how a rule set grants
  no actions to other actors, which is what this owner-only protocol intends. A
  regression test asserts no bundled definition declares an empty `$actions`.
- `@enbox/dwn-sdk-js`: `ProtocolRuleSet.$actions` documents the non-empty
  constraint and the `omit instead of []` remedy, so the rule is visible from
  editor hover and the emitted `.d.ts`.
