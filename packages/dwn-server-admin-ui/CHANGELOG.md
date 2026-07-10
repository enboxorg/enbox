# @enbox/dwn-server-admin-ui

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
