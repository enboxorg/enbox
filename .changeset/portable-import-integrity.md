---
"@enbox/crypto": patch
"@enbox/dids": patch
"@enbox/agent": patch
---

Validate portable DID documents, private/public key bindings, and known native algorithm metadata before target key storage. Apply configured DID method import validation through the agent, including did:dht identity-key binding. Reject private or symmetric key material in did:jwk identifiers during import and resolution, including partial RSA secrets in public JWKs.

Index stored private keys by their JWK thumbprints so imports preserve external key IDs and remain usable after DWN store indexes are rebuilt.
