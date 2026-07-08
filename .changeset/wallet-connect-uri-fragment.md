---
"@enbox/agent": patch
"@enbox/auth": patch
---

feat: carry the wallet connect request pointer and encryption key in the URI fragment

`EnboxConnectProtocol` now exposes `buildWalletConnectUri` and `parseWalletConnectUri`, which place the relay `request_uri` and the single-use `encryption_key` in the URI **fragment** rather than the query string. The fragment never leaves the local channel (it is not sent to the wallet's web server on the deep-link path), so the single-use symmetric key protecting the pushed request cannot surface in server or CDN logs. `WalletConnect.initClient` builds the wallet URI through the new helper; consumers that read connect parameters from a wallet URI should parse them with `parseWalletConnectUri`.
