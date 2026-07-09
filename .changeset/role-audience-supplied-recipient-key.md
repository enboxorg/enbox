---
"@enbox/agent": patch
---

feat: deliver role-audience keys to DWN-less recipients via a supplied role-path key

`ProcessDwnRequest` now accepts an optional `recipientRolePublicKey`. When writing a `$role` record with a `recipient`, the agent uses it to wrap the `$encryption/delivery` record instead of resolving the recipient's role-path key from the recipient's DWN-hosted protocol definition. A recipient's role-path key is a hardened derivation of its own encryption root — only the recipient can produce it, and a DWN-less participant (e.g. a bare `did:jwk` running in "remote-only" mode) has no DWN to publish it to. The recipient computes it locally and hands it to the owner out of band (e.g. in a signed join request) for delivery. The delivery record is written to the owner's DWN, so the participant stays DWN-less.

Supplying the key asserts that delivery **must** succeed: if it cannot be provisioned, the write throws. When no key is supplied, delivery is **best-effort** — the agent resolves the recipient's key from its installed protocol definition (local, then via the recipient's DWN), and a recipient whose key cannot be resolved (a supported DWN-less participant state) is reported on the new `DwnResponse.audienceKeyDelivery` (`{ delivered: false, recipientDid, reason }`) instead of failing an otherwise-valid `$role` write. This replaces a previously silent, default-off log: skipped deliveries are now visible and inspectable, while genuine "you asserted this must deliver" failures are loud.

Additional hardening:

- **Supplied-key validation.** `recipientRolePublicKey` must be a well-formed X25519 OKP public key (`kty: 'OKP'`, `crv: 'X25519'`, 32-byte `x`, no private `d`). A non-X25519 key (e.g. Ed25519) previously wrapped through the X25519 ECDH without error but produced an undecryptable delivery reported as `delivered: true`; it is now rejected (not converted — the role-path key is a derived X25519 key, not the DID root) before the record is written.
- **Idempotent repair.** Because the `$role` record is stored before provisioning runs, a strict delivery failure leaves an accepted-but-undelivered grant. Re-issuing the identical write (which returns `409`) now re-attempts delivery instead of skipping it, so a transient failure is recoverable by retry.
- **No silent drops.** Supplying `recipientRolePublicKey` on a path that cannot provision delivery — `sendRequest`, a raw message, or a non-`RecordsWrite` — now throws instead of being ignored.
- **`AudienceKeyDeliveryOutcome` is a discriminated union** (`{ delivered: true }` | `{ delivered: false; reason }`) so invalid states no longer type-check. Consumers reading `outcome.reason` must first narrow on `outcome.delivered === false`.
