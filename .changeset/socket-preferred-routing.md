---
"@enbox/dwn-clients": patch
"@enbox/agent": patch
---

feat: prefer the pooled WebSocket for control-plane DWN requests

`EnboxRpcClient.sendDwnRequest` now routes an `http(s)` endpoint's request
over the pooled WebSocket transport when it can serve it with full reply
parity: subscriptions always (the pool establishes the connection on
demand), and ordinary `dwn.processMessage` requests when an
already-healthy pooled socket exists and the frame fits the socket
budget. Data-bearing requests and `Read` messages stay on HTTP — request
payloads and streamed reply data are the HTTP framing's job. A missing or
reconnecting socket falls back to HTTP rather than waiting, and a
caller-supplied `ws:`/`wss:` transport override keeps plain scheme
routing. The sync engine passes endpoint URLs as configured instead of
hand-flipping `https` to `wss` for subscription opens.
