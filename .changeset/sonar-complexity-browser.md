---
"@enbox/browser": patch
---

refactor: reduce cognitive complexity and nesting in browser UI (Sonar S3776/S2004)

Behavior-preserving refactoring: extract-method on `encodeQr`, `drawCodewords`,
`runRelayConnect`, and the DRL click handler (S3776), plus hoisting six deeply-nested
closures in `connect-modal.ts` to module-level helpers (`settleWith`, `buildPinInputs`,
reuse of `walletInCatalog`) to satisfy S2004. All new helpers are module-private; no
public API signature changed. The QR encoder's output is unchanged (verified module-
for-module against the reference encoder), the relay PIN-retry loop preserves its exact
rethrow/continuation semantics (and `this` binding for `confirmComplete`), and the
mutable `pinResolve` state is proxied so reads/clears still hit the live variable.

Defers `qr.ts:409` (CC 40).

Verified: browser build + lint clean; qr oracle tests pass (module-for-module);
remaining UI behavior covered by the CI browser (Vitest) suite.
