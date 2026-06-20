---
"@enbox/agent": patch
---

Surface unexpected grant-lookup errors during sync. `getPermissionGrantId` in the sync push/pull paths previously swallowed every error and returned `undefined`, hiding real store/network/permissions failures behind the benign "no matching grant" path (the delegate then ran without a grant and failed opaquely). The catch is now narrowed to the expected not-found case; any other error propagates to the sync error handling.
