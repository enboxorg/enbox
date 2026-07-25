---
"@enbox/protocols": patch
---

Remove `SocialGraphProtocol`, `StatusProtocol`, and `ListsProtocol` from the shipped catalog together with their definitions, data types, codecs, and JSON Schemas. The removed Social Graph definition allowed anyone to create a `friend` role record, while current role invocation accepts a matching role recipient without independently binding the role to a trusted issuer. A caller could therefore self-assign friend authority and reach friend-gated data in protocols composed with that role. Profile no longer composes with Social Graph and no longer exposes `PrivateNoteData` or the friend-gated `privateNote` path.

This removal does not change engine role verification, uninstall definitions, revoke existing role records, or migrate stored data. Applications that installed these protocols should stop treating their role-gated records as confidential, install a corrected protocol under a new URI, migrate and re-encrypt sensitive records, and retire the old records. No replacement or compatibility aliases are provided.
