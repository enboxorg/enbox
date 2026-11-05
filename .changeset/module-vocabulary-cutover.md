---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
"@enbox/dwn-server-admin-ui": patch
"@enbox/agent": patch
"@enbox/connect": patch
"@enbox/auth": patch
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/cli": patch
"@enbox/local-node": patch
"@enbox/modules": patch
"@enbox/module-codegen": patch
---

Replace the protocol vocabulary with data modules across signed messages, storage,
SDKs, connect, sync, encryption identifiers, packages, and tooling. This is a
coordinated breaking cutover requiring fresh stores, sessions, configurations,
records, grants, and encryption material. Old wire formats and package aliases
are not supported.

The codegen package exports `generateModuleCode` to generate TypeScript source
from a DWN module definition and its schemas.
