---
"@enbox/dwn-sdk-js": patch
---

fix: stop config-history repair from purging valid encryption control records

`ProtocolsConfigure` revalidation fed `$encryption/audience` and `$encryption/delivery` records to the app-definition validator, which cannot recognize their reserved paths — destroying valid audience keys and deliveries on every same-URI policy upgrade. Control records are now revalidated in their own domain: they are purged only when the role path they provision no longer exists in the newest definition.
