---
"@enbox/dwn-server": patch
"@enbox/dwn-server-admin-ui": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

Require remote deployments to choose their tenant-admission and usage posture explicitly. Servers now require either a registration gate or `DWN_ALLOW_OPEN_TENANTS=true`, and both finite global quota limits or `DWN_ALLOW_UNBOUNDED_TENANT_USAGE=true`. Finite quota admission uses SQL usage accounting even when the admin API is disabled and now includes protocol configurations; deletes remain admissible at the limit so tenants can release data and converge.

Quota admission now executes under the SQL message store's tenant mutation lock and checks the actual post-mutation message count and latest-record data usage before committing. Exact retries and zero-growth or usage-reducing transitions remain admissible after a limit is reached or lowered, while concurrent growth cannot overbook one quota slot. External record data staged before a rejected mutation is rolled back without deleting a reference committed by a concurrent winner.

Remote Prometheus metrics now require existing admin authentication unless `DWN_PUBLIC_METRICS_ENABLED=true`. Global quotas are startup-only, zero-valued tenant overrides inherit the corresponding global limit rather than creating a tenant-only unlimited exception, and the admin UI no longer presents global quotas as runtime-editable. Tenant creation no longer accepts quota fields; create the tenant and use its dedicated quota endpoint. Store-backed admin statistics and finite quotas are unavailable when wrapping a prebuilt DWN because the server cannot prove ownership of its stores.

`HttpApi` and `WsApi` are no longer exported as parallel server construction paths; use `DwnServer` so startup exposure policies are always applied.
