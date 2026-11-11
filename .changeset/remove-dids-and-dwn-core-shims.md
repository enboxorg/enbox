---
"@enbox/agent": patch
"@enbox/dids": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
---

Require an explicit `squash` action for non-owner squash writes, drop the `{ nodes }` DWN service endpoint shape from delivery, stop decoding legacy `a=undefined` did:dht TXT records, reject malformed or host-less authoritative gateway URIs, and remove the `DidDhtUtils` wrapper class and the `DidKeyUtils` re-export from `did-key`.
