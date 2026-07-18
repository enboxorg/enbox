# @enbox/protocol-codegen

## 0.1.2

### Patch Changes

- [#1303](https://github.com/enboxorg/enbox/pull/1303) [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e) Thanks [@poindex-bot](https://github.com/poindex-bot)! - chore: resolve mechanical SonarCloud maintainability findings

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

## 0.1.1

### Patch Changes

- [#1120](https://github.com/enboxorg/enbox/pull/1120) [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency footprint by moving optional backends behind subpath imports and optional peer dependencies, removing unused DID and helper packages, and replacing small CLI/runtime dependencies with built-in implementations.
