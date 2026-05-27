---
"@enbox/auth": patch
---

Install KeyDeliveryProtocol for the agent DID before the first sync pull in `recoverIdentitiesFromRemote()`. Without this, the sync engine's closure resolver rejects encrypted JwkProtocol records (private keys) during recovery because the dependency protocol isn't present locally yet.
