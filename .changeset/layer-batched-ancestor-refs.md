---
"@enbox/dwn-sdk-js": patch
---

fix: emit all missing ancestor refs in one Incomplete

`applyReplicatedMessage` now layer-batches missing-ancestor dependencies: the incoming message's `contextId` is split into its recordId segments, each segment above the failure-named ancestor is presence-checked against the message store, and a single `Incomplete` names every locally-absent ancestor — for both the immediate-parent referential failure and record-chain construction failure — instead of surfacing one ancestry level per retry pass. Deep record chains now resolve in a bounded number of passes regardless of depth. Refs remain recordId selectors and the wire shape is unchanged.
