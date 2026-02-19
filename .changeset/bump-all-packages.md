---
"@enbox/common": patch
"@enbox/crypto": patch
"@enbox/dids": patch
"@enbox/browser": patch
"@enbox/dwn-sql-store": patch
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
---

fix: publish all packages so exported symbols match cross-package imports

The agent package ships prototyping code that imports symbols (AesKw,
Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
symbols exist in the source but were not in the published versions.
Bumping all packages ensures the published dist matches the current source.
