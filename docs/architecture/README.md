# Architecture Notes

This directory is for public architecture notes that explain how the Enbox
packages fit together. Detailed provider operations, Terraform, deployment
runbooks, cost models, and roadmap plans live outside this public monorepo.

## Runtime Shape

Enbox apps normally use the SDK stack rather than talking to every package
directly:

```text
app
  -> @enbox/api
    -> @enbox/auth
      -> @enbox/agent
        -> @enbox/dwn-clients
          -> @enbox/dwn-server
            -> @enbox/dwn-sdk-js
            -> @enbox/dwn-sql-store
```

The agent owns local identity material, vault state, DWN-backed stores, and
sync registration. The server hosts tenant DWNs over HTTP/WebSocket APIs and
persists messages/data through SQL-backed stores.

## Sync Model

Sync is centered on DWN records and protocol scopes:

- Wallets and apps register the protocols they are allowed to sync.
- Live sync uses server-delivered replication messages where available.
- Durable sync fills gaps through pull/push paths after reconnects.
- Bounded control requests and small byte-backed replication pushes reuse an
  existing connected WebSocket; streaming and larger pushes use HTTP.
- Automatic routing keeps `MessagesRead` and `RecordsRead` on HTTP because
  current WebSocket read replies do not carry their record-data streams.
  Dense pull catch-up uses query pages with inline messages and small payloads,
  which can reuse the socket instead of issuing individual reads.
- Large record data is stored through the DWN data store and must remain
  readable through both live and durable replication paths.

For the browser page/service-worker boundary, live application model, and local
replica lifecycle, see [Browser dapps](browser-dapps.md). The copyable scaffold
and deployment requirements live in the public
[`Build a browser dapp`](../../apps/docs/content/docs/guides/browser-dapp.mdx)
guide.

For local test infrastructure, see [Testing](../TESTING.md). For public server
hosting options and environment variables, see [Hosting](../HOSTING.md) and the
[`@enbox/dwn-server` README](../../packages/dwn-server/README.md).
