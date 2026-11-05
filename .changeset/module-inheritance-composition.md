---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/auth": patch
"@enbox/connect": patch
"@enbox/dwn-server": patch
"@enbox/modules": patch
"@enbox/module-codegen": patch
---

Add module inheritance and composition through one canonical dependency graph.
Resolve deep and chained attachments, shared roles and actor references to their
owning modules and physical record contexts. Preserve imported contracts across
same-URI updates, including retained records, and integrate canonical coordinates
with encrypted audiences, delegation, replication and delivery.

Typed modules use `defineModule({ definition, codecs, dependencies })`, exact local
codecs and explicit typed dependency artifacts. Installation prepares providers in
dependency order, reuses compatible installed providers and never grants provider
data access implicitly. Codegen supports explicit local dependency registries.
