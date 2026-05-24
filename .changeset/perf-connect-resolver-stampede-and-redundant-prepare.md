---
"@enbox/dids": patch
"@enbox/agent": patch
"@enbox/common": minor
---

perf(connect): single-flight DID resolver + connect.perf timing instrumentation

- `@enbox/dids`: `UniversalResolver.resolve` now coalesces concurrent
  no-options resolutions of the same DID via an in-flight map. Without this, parallel
  callers (e.g. the wallet's `Promise.all`-fanned `prepareProtocol` calls)
  each issued an independent BEP44 lookup against the `did:dht` relay,
  multiplying wall-time by N and saturating per-host browser connection
  limits. A second concurrent resolution for the same DID now awaits the
  first instead of starting its own. Calls that pass per-resolution options
  still resolve independently so method-specific options cannot be mixed.

- `@enbox/agent`: `submitConnectResponse` now emits `[connect.perf]`
  timing logs around the wallet-side critical path (delegate DID creation,
  permission grant fan-out, revocation grant creation/fan-out, response
  signing/encryption, callback POST, total) so operators can bisect remaining
  wall-time directly from wallet debug logs.

- `@enbox/common`: add reusable `nowMs()` and `timed()` helpers for
  monotonic elapsed-duration measurement and success/failure timing logs.
  `sleep()` now explicitly clamps negative durations to `0`, matching its
  documented behavior without relying on runtime timeout coercion.
