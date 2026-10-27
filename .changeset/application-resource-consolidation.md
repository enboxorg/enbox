---
"@enbox/api": patch
"@enbox/browser": patch
---

Consolidate live data under observe(), returning an ObservedStore for fixed native observations, changing inputs, or borrowed collections. Selectable stores start idle until select(input), preserve native capabilities, and cancel superseded read waits without interrupting other consumers. Collection write-refresh controls stay private; commands share progress through pendingInputs and may use a shorter caller lifetime.

Fold feature registration and manifest derivation into createApplication, with browser connection defaults supplied by the browser entrypoint. Remove the separate application definition, selected-collection API, and server-rendering snapshots.
