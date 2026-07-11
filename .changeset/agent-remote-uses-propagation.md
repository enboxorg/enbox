---
"@enbox/agent": patch
---

fix(agent): propagate out-of-batch `uses` dependencies during connect protocol preparation and surface per-endpoint failure reasons

A composed protocol's `ProtocolsConfigure` is rejected by the DWN when a `uses` target is not installed for the tenant, and the connect batch only orders dependencies the requester also asked for — so approving a request for a composed protocol (e.g. profile, which `uses` social-graph) against an endpoint missing the dependency failed deterministically, and the real 400 rejection was silently discarded, leaving only the generic "Could not verify the latest protocol definition on every reachable DWN endpoint" error.

`prepareProtocol` now propagates missing `uses` dependencies from the provider's locally stored configure entries (depth-first, transitive) to endpoints that are missing the dependent before sending its configure, checks the reply status of every configure send (previously fulfilled non-2xx replies were never read), and attaches the per-endpoint root cause — rejected sends, non-2xx replies with their detail, or the observed non-converged state — to the postcondition error.
