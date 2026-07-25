---
"@enbox/dwn-sdk-js": patch
---

Reject protocol definitions that combine `$role` and `$recordLimit` on the same path. Record-limit projection can hide stored records, so allowing those hidden records to remain role capabilities would make visible membership disagree with authorization.

Previously installed definitions and role records are not rewritten. Retire an affected protocol URI, install the corrected definition under a new protocol URI, and migrate only intended role assignments.
