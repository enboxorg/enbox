---
"@enbox/api": patch
---

feat(api): cross-tenant typed writes (#973) and api-layer parity batch

- `records.write` / typed `records.create` gain `from` — remote role- or grant-authorized writes into another tenant's DWN, routed via `sendDwnRequest` like remote reads; returned records are stamped with `remoteOrigin`. `Record.update` gains an opt-in `from` for cross-tenant co-updates; after a successful update the author is re-derived from the newly signed message and the remote origin is re-homed consistently on both the returned record and the mutated original. `recipientRolePublicKey` stays unsupported on the remote path (agent throws, surfaced); `audienceKeyDelivery` is never fabricated for remote writes.
- Typed `create` forwards `dateCreated` / `messageTimestamp`; typed path-level `delete` forwards `prune`.
- Public accessors: `enbox.dwn`, `enbox.connectedDid`, `enbox.delegateDid`, `typedEnbox.dwn` — the documented escape hatch to the raw layer.
- `TypedRecord.patch()` / `Record.patch()` — read-merge-write partial updates with null-deletes; `update({ data })` docs (and typing) fixed to reflect full-payload replacement.
- `records.queryAll()` on both the raw and typed surfaces — async-generator drain with internal pagination, liveness guards (repeated-cursor and consecutive-empty-page termination), a `maxPages` budget independent of the `maxRecords` yield cap, and loud call-time validation of numeric options.
- Typed query/read/subscribe derive the engine-required bare `parentId` + compound `contextId` filters from `parentContextId` on nested paths.
- `TypedEnbox.verifyInstalled()` — strict install verification (canonical definition compare + `$keyAgreement` coverage) with owner/delegate-aware statuses and a typed `WalletReapprovalRequiredError` instead of silent stale-delegate imports; `stripEncryptionBlocks` is now exported.
