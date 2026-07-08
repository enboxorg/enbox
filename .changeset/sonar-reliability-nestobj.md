---
"@enbox/dwn-server": patch
---

fix(dwn-server): avoid passing `nestObj` directly to `Array.prototype.reduce`

Wrap the query-param nesting helper in an explicit two-argument arrow so
`reduce`'s extra `index`/`array` arguments can never reach it. Behavior is
unchanged; this hardens the protocol-record and records-query handlers against
the class of bugs SonarCloud rule S7727 flags.
