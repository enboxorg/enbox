---
"@enbox/common": patch
"@enbox/dwn-server": patch
---

refactor: rename Web5-prefixed symbols in common and dwn-server packages

- `@enbox/common`: `Web5LogLevel` -> `LogLevel`, `Web5LoggerInterface` -> `LoggerInterface`, `Web5Logger` -> `EnboxLogger`, `window.web5logger` -> `window.enboxLogger`
- `@enbox/dwn-server`: `Web5ConnectServer` -> `ConnectServer`, `Web5ConnectRequest` -> `ConnectRequest`, `Web5ConnectResponse` -> `ConnectResponse`, `SetWeb5ConnectRequestResult` -> `SetConnectRequestResult`
- Moved `src/web5-connect/` -> `src/connect/` and `tests/web5-connect/` -> `tests/connect/`
- Deprecated aliases preserved for backward compatibility
