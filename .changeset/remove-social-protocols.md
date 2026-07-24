---
"@enbox/protocols": patch
---

Remove `SocialGraphProtocol`, `StatusProtocol`, and `ListsProtocol` from the shipped catalog together with their definitions, data types, codecs, and JSON Schemas. Profile no longer composes with Social Graph and no longer exposes `PrivateNoteData` or the friend-gated `privateNote` path. No compatibility aliases are retained.
