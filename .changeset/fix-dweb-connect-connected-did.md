---
"@enbox/browser": patch
---

fix(browser): read connectedDid from wallet response in DWeb Connect

The dapp client was falling back to `delegateDid.uri` (a `did:jwk` with no DWN endpoints) as the `connectedDid` when the wallet didn't explicitly send one. This caused "Failed to dereference `did:jwk:...#dwn`: notFound" errors during identity import after a successful wallet approval.

Now reads `connectedDid` from the wallet's authorization response, which contains the actual wallet owner's identity DID (e.g., `did:dht:...`).
