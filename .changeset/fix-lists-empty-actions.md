---
'@enbox/protocols': patch
---

fix(protocols): remove empty `$actions` arrays from `ListsDefinition` folder structure

The DWN JSON schema requires `$actions` arrays to have at least one item (`minItems: 1`).
Empty `$actions: []` on the `folder` type caused `ProtocolsConfigure` to fail with
`SchemaValidatorFailure` when installing the Lists protocol.
