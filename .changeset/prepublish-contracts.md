---
"@enbox/api": patch
"@enbox/agent": patch
"@enbox/dwn-server": patch
"@enbox/protocol-codegen": patch
---

Correct public record and agent store declarations for strict TypeScript consumers, including exact optional properties. Run the DWN server executable with Bun and resolve installed server and codegen versions from their package manifests.
