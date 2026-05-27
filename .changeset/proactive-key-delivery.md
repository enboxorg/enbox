---
"@enbox/agent": patch
---

Install KeyDeliveryProtocol proactively when a protocol with `encryptionRequired: true` is first installed, rather than lazily on the first encrypted write. This fixes a race condition where the sync engine's closure resolver couldn't find the dependency because the DWN event fired before `postWriteKeyDelivery` completed, and a recovery issue where encrypted JWK records couldn't be pulled on a fresh device.
