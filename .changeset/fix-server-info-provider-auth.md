---
"@enbox/dwn-clients": patch
---

fix: include providerAuth and maxInFlight in getServerInfo response

`HttpDwnRpcClient.getServerInfo()` explicitly mapped fields from the `/info` JSON response but omitted `providerAuth` and `maxInFlight`, causing provider-auth-v0 registration to silently fall through to the PoW path.
