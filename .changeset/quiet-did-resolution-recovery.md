---
"@enbox/dids": patch
"@enbox/agent": patch
"@enbox/auth": patch
---

Preserve transient DID gateway failures through local key and grant reads, and defer dependent sync and connection-monitor work until its next recovery attempt. Keep confirmed authorization and trusted cached DID documents available during an outage while retaining diagnostics for unexpected failures.
