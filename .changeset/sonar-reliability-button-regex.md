---
"@enbox/auth": patch
"@enbox/dwn-server-admin-ui": patch
---

fix: resolve open SonarCloud reliability findings (medium impact)

- `@enbox/dwn-server-admin-ui`: add an explicit `type="button"` to every
  standalone action `<button>` (none are inside a `<form>`), so clicking them
  can never trigger an implicit form submission (Sonar S9011).
- `@enbox/auth`: replace the regex-based `<code><separator><detail>` parser in
  `connect/status.ts` with an equivalent hand-written scan. The previous regex
  nested a quantified group inside an optional alternative
  (`\s+(?:[:-]\s*)?`), which Sonar's static analysis flags as capable of
  super-linear backtracking (S8786) even though empirical testing showed no
  actual quadratic blowup. The replacement is provably linear and was verified
  byte-for-byte equivalent to the old regex across 200k fuzzed inputs.

Also fixes the same button-type issue in two `apps/docs` components
(non-published, no changeset needed for `@enbox/docs`).
