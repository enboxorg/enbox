---
"@enbox/agent": patch
---

feat(agent): audience key delivery status and re-provision primitives

Adds two public `AgentDwnApi` primitives for role-audience key delivery so apps no longer hand-roll `$encryption/delivery` queries or touch-update `$role` records to force re-delivery:

- `getAudienceKeyDeliveryStatus` — resolves whether a delivery record wraps the CURRENT audience key of a tuple to a recipient (`delivered` / `not-delivered` / `unverifiable`). Matches deliveries on the current audience `keyId` (a stale delivery of a superseded key no longer reads as delivered) and short-circuits to `unverifiable` for delegate contexts, whose view of third-party deliveries is structurally visibility-filtered.
- `reprovisionAudienceKeyDelivery` — provisions the current audience key delivery for one recipient without touching the `$role` record. Skips the write when the current key is already delivered (`alreadyDelivered: true`), otherwise resolves/mints the audience under the usual seal-coverage rules and writes the delivery, reporting failures best-effort as `{ delivered: false, reason }`.

Also updates stale pre-best-effort doc comments on `ProcessDwnRequest.recipientRolePublicKey`, `AudienceKeyDeliveryOutcome`, and `DwnResponse.audienceKeyDelivery` to match the reporting semantics (only pre-write validation throws).
