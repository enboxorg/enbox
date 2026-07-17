---
"@enbox/browser": patch
---

refactor: reduce cognitive complexity of the QR mask-penalty function (Sonar S3776)

Behavior-preserving refactoring of `computePenalty` in the vendored QR-code generator
(was CC 40) to ≤15 by extracting the four QR mask-penalty rules (N1 adjacent runs,
N2 2×2 blocks, N3 finder-like patterns, N4 dark-module ratio) into module-level
helpers, summed in the same order. Every loop bound, weight/threshold constant, the
finder-pattern bit array, and the integer arithmetic are byte-for-byte unchanged.

Verified: browser build + lint clean; the QR encoder's output is unchanged
module-for-module vs. the reference encoder (mask selection depends on this penalty).
