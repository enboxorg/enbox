---
"@enbox/dwn-sdk-js": patch
---

refactor: reduce cognitive complexity in DWN handlers/core (Sonar S3776)

Behavior-preserving extract-method refactoring of 9 functions (CC 16–32) to the ≤15
threshold — RecordsWrite/RecordsSubscribe handlers, protocol-authorization action
resolution, integrity validation, message filter conversion, compound-index query,
storage squash, and delegated-grant integrity. Each extraction lifts a contiguous
block into a named helper called at the same point; the two non-verbatim transforms
(one De Morgan negation, one loop `return`/`continue`→boolean-predicate) are
algebraically exact. No authorization check reordered/weakened; no DwnError code or
message changed.

The two monster functions (`interfaces/protocols-configure.ts` CC 122 and
`handlers/protocols-configure.ts` CC 70) and the `index-level-compound` S107
parameter-count finding are deferred to dedicated follow-ups.

Verified: dwn-sdk-js build + lint clean; all 1578 tests pass.
