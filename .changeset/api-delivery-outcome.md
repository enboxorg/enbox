---
"@enbox/api": patch
---

feat: surface `audienceKeyDelivery` and accept `recipientRolePublicKey` on write surfaces

`records.write()`, `Record.update()`, and the typed `records.create()` / `TypedRecord.update()` surfaces now forward the agent's role-audience key-delivery outcome, and `records.write()` / typed create accept an optional caller-supplied `recipientRolePublicKey` that is passed through to `agent.processDwnRequest()`. `AudienceKeyDeliveryOutcome` is re-exported from the package index so apps can inspect delivery outcomes without reaching into `@enbox/agent` or private `_dwn` internals.
