---
"@enbox/agent": patch
---

fix(connect): install composed protocols in `uses`-dependency order

The connect approval ceremony prepared every requested protocol in one flat
concurrent fan-out. The DWN's `ProtocolsConfigure` handler rejects a configure
whose `uses` targets are not yet installed for the tenant, so a composing
protocol (e.g. one that `uses` a social-graph protocol for a role) could race
its dependency and land first — getting rejected and failing the fail-closed
remote convergence check. On a fresh identity, where nothing is pre-installed,
this reliably aborted the whole connect with "Could not verify the latest
protocol definition on every reachable DWN endpoint".

`prepareProtocol` is now fanned out in `uses`-dependency order: each protocol's
in-batch dependencies fully converge across all endpoints before its dependents
are prepared. Independent protocols within a dependency level are still prepared
concurrently, and dependency cycles fall back to the previous best-effort
concurrent behavior.
