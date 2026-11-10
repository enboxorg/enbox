---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/browser": patch
---

Support composed module extensions on followed foreign contexts and extract opinionated shared-context management into `@enbox/contexts`.

- `@enbox/dwn-sdk-js` & `@enbox/agent`: Unify root and consumer replication state in `FollowedSyncSource.modules` (`modules-v2` sync-store format; existing private sync stores must be reinitialized), add `resolveModuleRoleScope` and `ensureFollowedSourceModules`, bound transitive foreign `uses` loading, refresh delegate grant catalogs once per verification pass, recover cleanly when an accepted root role is replaced, and preserve global sync target-plan caching when optional consumer modules are unavailable.
- `@enbox/api` & `@enbox/browser`: Keep `defineModule()` pure without injecting hidden `enboxContextInvitation` or `enboxContextFollow` structure paths. Expose unopinionated `TypedEnbox.scope()`, `TypedEnbox.ensureReady()`, `TypedEnbox.roleDelivery`, `TypedEnbox.graph`, `Enbox.signal`, `StoreContext.enbox()`, and module graph/role-scope helpers on `Enbox.modules` while moving managed shared contexts, invitations, membership, and follow journals to `@enbox/contexts`.
