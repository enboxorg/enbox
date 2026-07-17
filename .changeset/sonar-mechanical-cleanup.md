---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/auth": patch
"@enbox/browser": patch
"@enbox/common": patch
"@enbox/crypto": patch
"@enbox/dids": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
"@enbox/dwn-server-admin-ui": patch
"@enbox/dwn-sql-store": patch
"@enbox/protocol-codegen": patch
---

chore: resolve mechanical SonarCloud maintainability findings

Behavior-preserving cleanup across the monorepo clearing the bulk of Sonar's
maintainability findings (no functional changes):

- `node:` protocol prefixes on Node built-in imports (S7772)
- `export…from` re-exports (S7763)
- `switch` → `if` where simpler, preserving all cases/defaults (S1301)
- nested ternary extraction (S3358), nullish coalescing where falsy-safe (S6606/S6644),
  optional chaining (S6582), `.at()` (S7755), `for…of` (S4138), `else if` (S6660),
  `.includes()`/`.findLast()`/`Math.max()` (S7765/S7750/S7766)
- `structuredClone()` over `JSON.parse(JSON.stringify())` (S7784)
- `Set` for existence checks (S7776), combined `Array#push` calls (S7778)
- `TypeError` for post-type-check throws, with messages (S7786/S7722)

Verified: full monorepo build + lint clean; crypto, common, dwn-sdk-js, dids,
dwn-clients, protocol-codegen, auth, api, and agent test suites all green.
