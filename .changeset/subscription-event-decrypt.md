---
"@enbox/agent": patch
"@enbox/api": patch
---

feat: opt-in decryption of subscription event payloads

`RecordsSubscribe` requests now accept `encryption: true` (auto-enabled by the typed layer on `encryptionRequired` paths): the agent decrypts the subscribe reply's initial snapshot entries and each event's inline payload before delivery, so subscription consumers read plaintext from `record.data` without re-reading every record through the read path. Events without inline data (large records) keep the lazy decrypting read; a record that cannot be decrypted never kills the subscription — its inline ciphertext is withheld and `record.data` rejects with the decryption error via the lazy read.
