---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/auth": patch
---

perf: eliminate startup and reload bottlenecks

- Cache vault `getDid()` result (avoids JWE decrypt + BearerDid.import on every call)
- Eliminate duplicate X25519 context key derivation in `postWriteKeyDelivery()`
- Parallelize grant processing, vault encryptions, storage writes, and post-write operations
- Cache sync targets with 30s TTL (avoids DID resolution on every sync tick)
- Cache `encryptionRequired` / `hasEncryptedTypes` at construction time
- Replace protocol init TtlCache with permanent Set
- Skip unnecessary `lock()` in `unlock()` when already locked
