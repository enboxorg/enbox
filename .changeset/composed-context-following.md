---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
---

Follow shared contexts with explicitly selected module extensions using `contexts.withModules()` and `context.using()`. Verify each extension against the accepted root role, synchronize its records through separate scoped links, and recover optional consumer views without blocking the root. Keep one root follow/forget decision and retire all bindings when its acceptance changes.

Replace separate root and consumer sync state with one required module-scope map. The private sync-store format is now `modules-v2`; existing sync stores must be reinitialized. No legacy row reader or migration is provided. Typed module artifacts now contain definitions, codecs, and dependencies; their derived graph is no longer exposed as a second representation.
