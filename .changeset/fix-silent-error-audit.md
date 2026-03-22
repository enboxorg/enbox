---
"@enbox/agent": patch
"@enbox/auth": patch
---

fix: eliminate silent error swallowing anti-patterns across agent and auth

Comprehensive audit of all try/catch blocks that silently swallow errors.
Five fixes:

1. **Security**: Password provider errors now log the error before falling
   through to the insecure default, so developers can distinguish "provider
   threw" from "no provider configured".

2. **Correctness**: Remote protocol definition fetch now only treats
   "not found" responses as missing protocols. Transient errors (network,
   auth) are rethrown so the caller does not silently skip encryption.

3. **Data integrity**: Identity deletion now propagates DID/key deletion
   errors instead of deleting the identity record anyway, which would
   leave orphaned cryptographic key material.

4. **Debuggability**: Corrupt sync identity options in LevelDB now log a
   warning before falling back to global sync.

5. **Correctness**: `registerIdentity` during session restore now only
   catches "already registered" errors; other errors (LevelDB failures)
   are rethrown.
