---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
---

Follow shared contexts with explicitly selected module extensions using `contexts.withModules()` and `context.using()`. Verify each extension against the accepted root role, synchronize its records through separate scoped links, and recover optional consumer views without blocking the root. Keep one root follow/forget decision and retire all bindings when its acceptance changes.
