---
"@enbox/dwn-sdk-js": patch
---

feat: mark permission records immutable

The permissions protocol now sets `$immutable: true` on the `request`, `grant`, and `grant/revocation` paths. Permission records are write-once by design — a grant is never amended, it is revoked and re-issued — and immutability locks each record's initial-write facts (notably the `protocol` tag), which replication fingerprint domains and protocol-scoped shadow filters are computed from. Updates to existing permission records (including tags-only mutations) are now rejected with `ProtocolAuthorizationImmutableRecord` in both `processMessage` and `applyReplicatedMessage`; creating permission records and revoking grants are unaffected.
