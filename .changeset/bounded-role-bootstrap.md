---
'@enbox/dwn-sdk-js': patch
---

Return a bounded dependency closure when an authenticated role holder reads a context root for replica bootstrap. Include ancestry-only role proofs for role-signed writes and deletes, normalize root and nested role identities consistently, and avoid emitting a proof already carried by the record ancestry.
