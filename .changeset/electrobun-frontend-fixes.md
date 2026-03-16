---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
---

fix(agent): prefer locally-stored BearerDid for signing to avoid unnecessary DID resolution round-trips

fix(dwn-clients): remove unreachable duplex half-duplex assignment after ReadableStream-to-Blob buffering
