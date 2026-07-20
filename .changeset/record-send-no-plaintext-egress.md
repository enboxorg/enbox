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
`records.write({ encryption: true })`, decrypting reads, and the
`records.subscribe` / `messages.subscribe` decryption paths.

Transmission now sources the record's **at-rest bytes** — for an encrypted
record the ciphertext, re-read WITHOUT decryption so it matches `dataCid` — and
never the decrypted in-memory cache nor the decrypting `data` getter. The
encrypted-transmit path has no code that can reach the plaintext, so it cannot
leak by construction. The decrypted read cache is untouched, so `record.data`
still serves plaintext without a re-read.

Consequences:

- Encrypted `record.send()` now **succeeds** instead of leaking plaintext and
  400-ing (the mismatch was the bug's symptom).
- When the ciphertext cannot be sourced — e.g. a record created with
  `store: false` and never persisted — transmission **fails closed** rather than
  falling back to plaintext.
