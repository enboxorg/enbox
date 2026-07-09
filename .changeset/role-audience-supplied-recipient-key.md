---
"@enbox/agent": patch
---

feat: deliver role-audience keys to DWN-less recipients via a supplied role-path key

`ProcessDwnRequest` now accepts an optional `recipientRolePublicKey`. When writing a `$role` record with a `recipient`, the agent uses it to wrap the `$encryption/delivery` record instead of resolving the recipient's role-path key from the recipient's DWN-hosted protocol definition. A recipient's role-path key is a hardened derivation of its own encryption root — only the recipient can produce it, and a DWN-less participant (e.g. a bare `did:jwk` running in "remote-only" mode) has no DWN to publish it to. The recipient computes it locally and hands it to the owner out of band (e.g. in a signed join request) for delivery. The delivery record is written to the owner's DWN, so the participant stays DWN-less.

Supplying the key asserts that delivery **must** succeed: if it cannot be provisioned, the write throws. When no key is supplied, delivery is **best-effort** — the agent resolves the recipient's key from its installed protocol definition (local, then via the recipient's DWN), and a recipient whose key cannot be resolved (a supported DWN-less participant state) is reported on the new `DwnResponse.audienceKeyDelivery` (`{ delivered: false, recipientDid, reason }`) instead of failing an otherwise-valid `$role` write. This replaces a previously silent, default-off log: skipped deliveries are now visible and inspectable, while genuine "you asserted this must deliver" failures are loud.
