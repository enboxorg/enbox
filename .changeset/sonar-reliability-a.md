---
"@enbox/browser": patch
---

fix: await the popup promise inside its try so failures are handled uniformly (Sonar S4822)

`startPopup` invoked `deps.runPopup(...)` and attached `.then/.catch/.finally` inside a
try/catch. S4822 flags a promise-returning call sitting inside a try that is neither
awaited nor chained there — the try appears to guard the popup's failure but doesn't
(the rejection is handled by `.catch`, the try only catches a synchronous throw).

Fix per the rule's guidance: make `startPopup` async and `await deps.runPopup(...)`
inside the try. `runPopup` is still invoked synchronously (its `window.open` runs before
the first await, preserving the user-gesture popup open), and the single try/catch/finally
now handles both a synchronous throw (a custom transport) and an async rejection, resetting
`popupBusy` in `finally`. Behavior is unchanged (verified against the existing popup
success/denied/closed/blocked/timeout/sync-throw tests).

This clears the last open bug, restoring the project's Reliability rating to A.
