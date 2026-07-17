---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
---

feat(dwn-sdk-js): BroadcastChannel-bridged event-log wakes for sibling contexts

New `BroadcastChannelWakePublisher` fans each store wake out to in-process listeners and mirrors it over a named `BroadcastChannel`, so sibling execution contexts sharing one underlying store (browser tabs, workers, a SharedWorker over the same IndexedDB) observe each other's commits immediately instead of waiting for the durable event log's idle re-drain (~30s). Wakes received from the channel are never re-posted (no loops), non-wake traffic is ignored, and environments without `BroadcastChannel` degrade to in-process-only delivery.

The agent's default message log now derives a channel name from the store location, so local subscriptions in one tab fire promptly when another tab (or a worker) writes — including writes applied by sync running in a different context.
