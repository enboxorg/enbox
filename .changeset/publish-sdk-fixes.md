---
"@enbox/common": patch
"@enbox/dids": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
---

fix: publish unpublished fixes across packages

- `@enbox/common`: `open()` in KeyValueStore interface
- `@enbox/dids`: `DidResolverCacheMemory`, resolver lifecycle management
- `@enbox/dwn-sdk-js`: `DidResolverCacheMemory` default in `Dwn.create()` (fixes "Database is not open" in containers)
- `@enbox/dwn-clients`: `DwnServerInfoCacheMemory`
- `@enbox/dwn-server`: Actor delivery, noop resolver cache, registration gate fix
