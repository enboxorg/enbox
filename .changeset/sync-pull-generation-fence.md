---
"@enbox/agent": patch
---

fix: one generation owns a link's pull deliveries and subscription pair

Live pull keeps its concurrent delivery model (handlers fire without
awaiting; an ordinal tracker advances the checkpoint over the
contiguously committed prefix), and a single per-link generation now
fences everything transient around it. Pausing, repairing, or resetting
a link bumps the generation synchronously, before any await, and:

- deliveries carry a generation ticket, so one still admitting across a
  repair cannot collide with a reissued ordinal and mark durable
  progress over a message that never applied;
- out-of-scope events acknowledge through the ordinal tracker instead
  of directly persisting their cursor, so they cannot skip past an
  earlier covered delivery still admitting;
- one generation is captured for the whole subscription pair: both
  opener halves validate it after every await and attach through a
  generation-fenced install, a pause landing between the halves stops
  the attempt before the local half opens, a pause or repair landing
  while an open is in flight closes the returned subscription instead
  of installing a permanently fenced slot, a stale ProgressGap or
  rejection is that attempt's teardown rather than a fresh failure,
  and completing initialization cannot mark a paused link live;
- cleanup is attempt-owned: a superseded opener no longer closes the
  replacement generation's subscription pair;
- callbacks and processing rejections from a superseded subscription —
  remote pull and local push alike — are discarded silently instead of
  writing checkpoints, enqueueing redundant pushes, spamming error
  reports, or re-triggering repair on a healthy link.
