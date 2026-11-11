---
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
---

Use a single HTTP DWN RPC body framing format and remove legacy `/dwn-server/package.json` manifest fallbacks.

- `@enbox/dwn-clients`: Always send HTTP JSON-RPC requests as `application/vnd.enbox.dwn-rpc` length-prefixed bodies without `/info` capability-discovery probes, `body-v1` version parameters, or `dwn-request` header fallbacks.
- `@enbox/dwn-server`: Require `application/vnd.enbox.dwn-rpc` body framing on HTTP JSON-RPC POST requests and outbound `DeliveryService` forwarding/delivery, stop advertising `httpRpcFraming` in `GET /info`, and resolve server version metadata directly from `@enbox/dwn-server/package.json`.
