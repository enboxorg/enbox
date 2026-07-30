# @enbox/protocol-codegen

## 0.1.5

### Patch Changes

- [#1510](https://github.com/enboxorg/enbox/pull/1510) [`46c74fd`](https://github.com/enboxorg/enbox/commit/46c74fd26adeb617d79235fe18a97dca0be7194a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Generate self-contained validators for resolved JSON schemas, support browser-only runtime imports, and emit the published CLI and library entrypoints at their declared paths.

## 0.1.4

### Patch Changes

- [#1493](https://github.com/enboxorg/enbox/pull/1493) [`31ac51e`](https://github.com/enboxorg/enbox/commit/31ac51e94662abb02f65c15739407b96418ffd35) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Require reachable JSON payload schemas to resolve locally as object documents with matching string `$id` values and fragment-only `$ref` values, add deterministic no-follow generated-output checks, and make permissive unresolved generation explicit.

## 0.1.3

### Patch Changes

- [#1463](https://github.com/enboxorg/enbox/pull/1463) [`96c5dbd`](https://github.com/enboxorg/enbox/commit/96c5dbddfb921a4972dc552a4d64ea9c7086b6ad) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace phantom schema-map typing with runtime record codecs. Typed records now encode and decode through their protocol declaration, expose application values through `Record.value()`, and use `within` as the single hierarchy selector. Remove the superseded schema-map types, caller-controlled `Record.update()` data-format overrides, generic `RecordData.json<T>()`, and root utilities namespace. Typed protocol declarations reject `$ref` composition until referenced protocol metadata can be supplied explicitly.

  Replace the public `generateTypes()` and `CodegenOptions.emitDefinition` codegen surface with `generateProtocolModule()`, which emits complete codec-backed protocol modules from protocol definitions and declared MIME formats. Expose the codec primitives through the browser and CLI facades.

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
