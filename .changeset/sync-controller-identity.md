---
"@enbox/agent": patch
---

refactor(agent): make controller identity the staleness axis for link work

Repair, reconcile scheduling, and push-failure routing now flow `SyncLinkController` references instead of `(linkKey, link)` pairs: the recovery coordinator's `transitionToRepairing`/`scheduleLinkReconcile`/`scheduleReconcile`, its `handlePushFailures` operation, the push coordinator's `handleReconcileFailures`, and the live-pull processor's repair/reconcile operations are controller-addressed, deleting the scattered `controller.link === link` object-identity re-checks in favor of `controller.isActive`. Link-addressed entry points that legitimately run without a controller keep their addressing: `transitionToPaused` still persists the paused status for poll-mode links, and the engine's `scheduleLinkReconcile` boundary resolves feed-convergence/quota-manager requests to a matching active controller exactly as the deleted internal guards did. No behavior change; fourth step of the runtime-scope (Phase-2) refactor.
