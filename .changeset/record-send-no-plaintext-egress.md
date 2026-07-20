---
"@enbox/api": patch
---

fix(api): never transmit the plaintext of an encrypted record on send/store

**Security fix.** `Record.send()`, `store()`, and `import()` sourced their
outgoing bytes from the record's decrypted read path, so for an ENCRYPTED record
they transmitted the **plaintext** to the target DWN — defeating the encryption
(the `RecordsWriteDataCidMismatch` 400 that followed was only the wreckage after
the plaintext had already egressed, since `descriptor.dataCid` commits to the
ciphertext). Every decrypting surface produced such records:
`records.write({ encryption: true })`, decrypting reads, and decrypting
`records.subscribe`.

Transmission now ships the record's **at-rest bytes** — the bytes `dataCid`
commits to — from one of two provenance-tracked sources, never the decrypted
cache nor the decrypting `data` getter:

- A cache known to hold at-rest bytes (`cachedDataAtRest`): unencrypted
  plaintext, or ciphertext from a NON-decrypting read/query/subscription. Reused
  as-is.
- Otherwise, for an encrypted record whose cache is the decrypted payload, a
  fresh NON-decrypting read of the stored ciphertext.

Provenance is tracked explicitly and defaults to "plaintext / fail closed" for
unknown origin, so the encrypted-transmit path cannot reach the plaintext by
construction. The decrypted read cache is untouched — `record.data` still serves
plaintext without a re-read.

Consequences:

- Encrypted `record.send()` now **succeeds** instead of leaking plaintext and
  400-ing (the mismatch was the bug's symptom).
- A record whose cache is the decrypted payload (an encrypted `write`, a
  decrypting read, a decrypting subscription) does one **extra non-decrypting
  read** to source the ciphertext on send/store. Records already holding at-rest
  ciphertext (non-decrypting query/read) are reused with no extra read.
- Consequently, `store()` / `import()` of a record whose authoritative copy is
  **remote** (`remoteOrigin` set) and whose cache is decrypted now performs a
  network round-trip to read the remote ciphertext, and fails offline where it
  previously used the cache.
- When the ciphertext cannot be sourced at all — e.g. a record created with
  `store: false` and never persisted — transmission **fails closed** with an
  actionable error rather than falling back to plaintext.

Additional integrity guards:

- `Record.update()` now **rejects** changing the encryption mode without
  supplying `data` (e.g. `update({ encryption: false })` on an encrypted record).
  The stored payload cannot be decrypted (nor a plaintext one encrypted) in
  place, and allowing it produced a record whose message and stored data
  disagreed — which a later send would egress the wrong bytes for. Pass `data`
  to re-write under the new mode.
- The non-decrypting fallback read now **verifies the read version's `dataCid`
  matches this record** before returning its bytes, so a `send()`/`store()`
  cannot ship a different stored version's data (a newer write, or a
  `store: false` version) under this record's message.
- A **local** `update()` (no `from`) now clears `remoteOrigin`, so a
  remote-read-then-locally-updated record sources its newly stored **local**
  bytes instead of a stale remote version.

Known gap (tracked separately): an encrypted `write({ store: false })` cannot be
sent, because the ciphertext is never persisted for the fresh read to find. The
durable fix is for the encrypting write to return the ciphertext so `Record` can
cache it as at-rest.
