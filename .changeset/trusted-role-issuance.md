---
"@enbox/dwn-sdk-js": patch
---

Reject protocol definitions that allow `anyone` to create or squash a `$role` record. Role assignments now require an authorized issuer whose authority is rooted in the tenant, an explicit grant or delegate, an ancestor relationship, or an existing role.

Previously installed definitions and role records are not rewritten. Applications that installed an open role-assignment path should retire that protocol URI, install a corrected definition under a new URI, migrate authorized assignments, and stop relying on records issued under the unsafe definition.
