---
"@enbox/agent": patch
"@enbox/auth": patch
---

fix: install key-delivery protocol on delegate's local DWN during connect

The sync engine's closure validator requires the key-delivery protocol to be
installed locally for any encrypted protocol. Without it, sync links for
encrypted records transition to `repairing` state with
ClosureEncryptionDependencyMissing warnings. The key-delivery protocol is now
installed on the delegate's local DWN during importDelegateAndSetupSync.

Also exports KeyDeliveryProtocolDefinition from @enbox/agent.
