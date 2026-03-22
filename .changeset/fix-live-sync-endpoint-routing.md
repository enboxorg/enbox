---
"@enbox/agent": patch
---

fix(agent): route live pull subscriptions to specific dwnUrl instead of first-resolved endpoint

openLivePullSubscription used agent.dwn.sendRequest({ target: did }) which
resolves all DWN endpoints from the DID document and connects to the first
one. When a DID has multiple endpoints, the pull subscription could connect
to a different server than the one receiving push writes — so events pushed
to server A were never relayed to the subscriber on server B.

Now constructs the MessagesSubscribe message via processRequest and sends it
directly to the specific dwnUrl (converted to wss://) via agent.rpc.sendDwnRequest,
ensuring the pull subscription is on the same server that receives pushes for
that sync target. Also includes a resubscribe factory for cursor-based resume
on WebSocket reconnection.
