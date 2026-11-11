---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/api": patch
"@enbox/browser": patch
---

Support composed module extensions on followed foreign contexts and extract opinionated shared-context management into `@enbox/contexts`.

- `@enbox/dwn-sdk-js`, `@enbox/dwn-sql-store`, `@enbox/agent` & `@enbox/auth`: Unify root and consumer replication state in `FollowedSyncSource.modules`, support descendant `$ref` attachments in `resolveModuleContextRoot` and `resolveModuleRoleScope`, add `ensureFollowedSourceModules`, bound transitive foreign `uses` loading, refresh delegate grant catalogs once per verification pass, recover cleanly when an accepted root role is replaced, preserve global sync target-plan caching when optional consumer modules are unavailable, and remove store/session format version markers.
- `@enbox/api` & `@enbox/browser`: Keep `defineModule()` pure without injecting hidden `enboxContextInvitation` or `enboxContextFollow` structure paths. Expose unopinionated `TypedEnbox.scope()`, `TypedEnbox.ensureReady()`, `TypedEnbox.roleDelivery`, `TypedEnbox.graph`, `Enbox.signal`, `StoreContext.enbox()`, and `ModuleContextAttachmentPath` while consolidating advanced graph/role-scope extension primitives onto `@enbox/api/advanced` and moving managed shared contexts, invitations, membership, and follow journals to `@enbox/contexts`.
