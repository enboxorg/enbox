---
'@enbox/api': patch
'@enbox/browser': patch
---

Name observable record and context results as view state: `RecordViewState` and `ContextViewState` expose a `status` discriminator, while their views provide `getState()` and publish the same state through `subscribe()`.

Migration: replace `RecordViewSnapshot` / `ContextViewSnapshot` with `RecordViewState` / `ContextViewState`, `view.getSnapshot()` with `view.getState()`, and `state.state` with `state.status`.

The former scalar `RecordViewState` name is now `ReplicationCurrentness`; `RecordViewState<Item>` represents the complete observable record-view state.
