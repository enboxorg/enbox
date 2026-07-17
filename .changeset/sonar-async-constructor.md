---
"@enbox/browser": patch
---

fix: move the DWeb Connect transports' rejection-handled markers out of their constructors

Extracts a `createHandledDeferred` helper so the no-op `.catch()` that
pre-marks early rejections as handled no longer runs inside the
`PopupClientTransport` / `WalletPostMessageTransport` constructors
(Sonar S7059). No behavior change.
