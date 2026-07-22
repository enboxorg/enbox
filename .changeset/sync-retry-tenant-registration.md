---
"@enbox/agent": patch
---

fix: retry live-sync link initialization while a newly created tenant is still registering

A freshly created identity's remote DWN briefly rejects `MessagesSubscribe` with `401 Not a registered tenant` until tenant registration lands there. This transient 401 is now classified like `did:dht` propagation lag: the link re-initializes on the short backoff ladder (`isTransientInitFailure`) and logs at `warn` rather than retiring the link with an alarming `error` and waiting for the periodic (5-minute) settle check. Because the pull subscription opens before the baseline push, retrying also unblocks the initial push of records written during identity creation (e.g. a new profile), so they reach the remote without waiting for the next settle pass or an app restart.
