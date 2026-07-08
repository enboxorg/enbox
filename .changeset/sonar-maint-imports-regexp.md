---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/auth": patch
"@enbox/common": patch
"@enbox/dids": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
---

fix: resolve SonarCloud maintainability issues (S3863/S6594)

Behavior-preserving source cleanups:

- S3863: merge duplicate `import` statements from the same module into a
  single statement (re-sorting to satisfy the repo's `sort-imports` rule).
- S6594: use `RegExp.exec()` instead of `String#match()` for the non-global
  route/type regexes in the DWN server and `universalTypeOf`.
