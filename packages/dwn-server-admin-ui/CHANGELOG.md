# @enbox/dwn-server-admin-ui

## 0.1.2

### Patch Changes

- [#1306](https://github.com/enboxorg/enbox/pull/1306) [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211) Thanks [@poindex-bot](https://github.com/poindex-bot)! - chore: resolve SonarCloud type/class-hygiene and test-quality findings

  Behavior-preserving cleanup (no functional changes):

  - **readonly** on public static / constructor-only members (S1444, S2933)
  - **named type aliases** for repeated inline unions (S4323)
  - **more specific test assertions** — `toBeInstanceOf` / `toBeNull` / `toHaveLength` (S5906)
  - merged identical conditional branches (S1871), `String.raw` (S7780), `.dataset` /
    `.remove()` DOM APIs (S7761/S7762), class-field init (S7757), `self`→lexical-`this`
    arrow closures (S7740), removed redundant `| undefined` (S4782), removed an
    unnecessary regex escape (S6535), documented intentional no-op methods (S1186),
    nested-template extraction (S4624), and a `role="button"` span → real `<button>`
    in the admin UI (S6819).

  Redundant-type-alias findings (S6564) on exported public API types, duplicated-code
  findings (S4144) needing design judgment, deprecated-API swaps without a drop-in
  replacement (S1874), and a few tests needing author intent were deliberately left
  for follow-up rather than risk breaking API or behavior.

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

- [#1331](https://github.com/enboxorg/enbox/pull/1331) [`d6f72b4`](https://github.com/enboxorg/enbox/commit/d6f72b4ec9f50fd86f288021416c7f22a61c60ed) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: resolve open SonarCloud reliability findings (medium impact)

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

## 0.1.1

### Patch Changes

- [#1212](https://github.com/enboxorg/enbox/pull/1212) [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve remaining SonarCloud reliability issues (S7773/S7781/S7758/S6853/S8786)

  Behavior-preserving reliability hardening across packages:

  - Replace global `parseInt`/`isNaN` with `Number.parseInt`/`Number.isNaN` (S7773).
  - Replace `String#replace(/…/g)` and `split().join()` with `String#replaceAll` (S7781).
  - Prefer `String.fromCodePoint`/`String#codePointAt` in byte-range encoders (S7758).
  - Associate admin-UI form labels with their inputs via `for`/`id` (S6853).
  - Strip trailing slashes in the local-node `/info` handler with a linear loop
    instead of a backtracking-prone regex (S8786).

- [#1218](https://github.com/enboxorg/enbox/pull/1218) [`aa79fe6`](https://github.com/enboxorg/enbox/commit/aa79fe6257ca53fd66f10b7eab1a3d16d07b041c) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix(admin-ui): use `htmlFor` so label/control association is detected

  The audit-log and passkey filter labels associated their inputs via `for`/`id`.
  That is valid HTML a11y, but the `jsx-a11y` rule behind SonarCloud S6853 only
  recognizes the `htmlFor` prop, so it kept flagging the labels as unassociated.
  Preact 10 renders `htmlFor` to the same `for` attribute, so the output HTML is
  unchanged — this just makes the association visible to the analyzer.
