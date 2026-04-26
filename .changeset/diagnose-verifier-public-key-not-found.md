---
"@enbox/dwn-sdk-js": patch
---

fix(dwn-sdk-js): surface DID and resolution metadata in `GeneralJwsVerifierGetPublicKeyNotFound`

The previous error message — `"public key needed to verify signature not found in DID Document"` — could not distinguish a failed DID resolution (e.g. `did:dht` not yet propagated to the Pkarr relay, network error, unsupported DID method) from a genuine `kid` mismatch against a successfully resolved document. This made wallet-connect failures (e.g. `[@enbox/auth] Failed to store grant in delegate partition: GeneralJwsVerifierGetPublicKeyNotFound: ...`) effectively undebuggable.

The verifier now includes the offending `kid`, the DID being resolved, and either the `didResolutionMetadata.error` / `errorMessage` or the list of available verification method IDs. Behaviour and error code (`GeneralJwsVerifierGetPublicKeyNotFound`) are unchanged.
