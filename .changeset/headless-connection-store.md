---
"@enbox/auth": patch
"@enbox/api": patch
"@enbox/browser": patch
---

feat: add a framework-agnostic connection store and a typed connect-denied error

- `@enbox/auth`: connect, refresh, and wallet-connect denials now throw a typed `ConnectDeniedError` (messages unchanged); branch on the new `isConnectDeniedError()` predicate instead of string-matching error messages.
- `@enbox/api`: new `createConnectionStore()` — a headless, subscribable store that composes `AuthManager` + `Enbox` into one observable state machine (`initializing | disconnected | connecting | connected | error`), with `getSnapshot()`/`subscribe()` for `useSyncExternalStore`-style bindings, in-flight guards, delegated connection monitoring, and `dispose()` teardown.
- `@enbox/browser`: re-exports `createConnectionStore`, its types, `ConnectDeniedError`, and `isConnectDeniedError`.
