---
"@enbox/agent": patch
---

fix: fence live-pull deliveries by pull generation

Pull deliveries now carry a generation ticket instead of a bare ordinal.
Clearing or resetting a link's pull runtime (what pausing and repair do)
starts a new generation, so a delivery that was still admitting when a
repair re-established the pull boundary can no longer collide with a
fresh delivery's reissued ordinal and mark it committed before it
actually applied — previously the checkpoint could claim contiguous
progress over a message that was never admitted. Live-pull subscription
callbacks are additionally fenced by the generation captured at open, so
an EOSE or event from a superseded subscription cannot write checkpoint
tokens or send a freshly repaired link straight back into repair via a
stale token-domain mismatch.
