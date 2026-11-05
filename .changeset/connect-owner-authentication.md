---
"@enbox/connect": patch
---

Add versioned owner authentication to Connect, with a separate authentication-only client/result path, strict owner-key proof verification and an optional service-owned replay store. Existing delegation and refresh results remain compatible.

Proof verification requires an explicit expected service audience and issued challenge alongside the stored request. Legacy delegation inputs retain JSON wire semantics when captured, including reactive proxies, while authentication inputs retain strict validation. Signer acquisition failures preserve their diagnostic cause behind the fixed authentication error message.
