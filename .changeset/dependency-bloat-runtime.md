---
"@enbox/dwn-sql-store": patch
"@enbox/dwn-server": patch
"@enbox/dids": patch
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/protocol-codegen": patch
---

chore: reduce runtime dependency footprint by moving optional backends behind subpath imports and optional peer dependencies, removing unused DID and helper packages, and replacing small CLI/runtime dependencies with built-in implementations.
