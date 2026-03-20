---
"@enbox/dwn-sdk-js": patch
---

fix(dwn-sdk-js): return 409 for duplicate ProtocolsConfigure messages

ProtocolsConfigureHandler now checks if the incoming message CID already
exists before attempting storage.  Previously, re-processing the same
ProtocolsConfigure (e.g. when the batched-diff sync pushes a message the
remote already has) would attempt a second INSERT into the MessageStore,
violating the unique constraint on (tenant, messageCid) in PostgreSQL and
returning a -32603 internal error to the client.
