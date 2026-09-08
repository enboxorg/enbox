---
"@enbox/dids": patch
"@enbox/agent": patch
"@enbox/auth": patch
---

Preserve transient DID gateway failures through endpoint discovery, signing-method lookup, and local key and grant reads. Defer dependent sync and connection-monitor work until its next recovery attempt, keeping confirmed authorization and trusted cached DID documents available during an outage while retaining diagnostics for unexpected failures.
