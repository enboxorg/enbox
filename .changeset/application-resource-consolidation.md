---
"@enbox/api": patch
"@enbox/browser": patch
---

Consolidate feature observations under one resource owner for fixed native views, changing inputs, and borrowed canonical collections. Resource state exposes selection and pagination progress while preserving native record and context payloads and controls. Commands may share a caller lifetime. Fold feature registration and manifest derivation into createApplication, with browser connection defaults supplied by the browser entrypoint; remove the separate application-definition and selected-collection APIs.

Remove server-rendering snapshots from resource and command handles. Consumers read their current state through getSnapshot and subscribe.
