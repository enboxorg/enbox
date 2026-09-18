# Browser dapp architecture

This document defines the browser runtime boundary. Keep copyable setup,
deployment, and verification instructions in the public
[`Build a browser dapp`](../../apps/docs/content/docs/guides/browser-dapp.mdx)
guide so developers have one implementation recipe.

## Runtime ownership

An Enbox dapp has two browser execution contexts with different lifetimes:

```text
page
  UI
  one ConnectionStore
  Enbox facade and observable record views
  live WebSocket sync and subscriptions
           │
           │ ordinary fetch / <img src> for DRLs
           ▼
service worker
  precached application shell
  activatePolyfills() DRL fetch interception
           │
           ▼
DWN servers, wallet connect, and DID resolution
```

The page owns the session, typed APIs, live views, and sockets. The service
worker owns the fetch boundary for Decentralized Resource Locators (DRLs) and
the offline application shell. Browsers may terminate a worker between events,
so it cannot host a durable application session or open WebSocket.

When a page resumes after suspension, the SDK reconnects and reconciles its
durable feeds. Moving the live runtime into a worker does not improve that
behavior and makes session lifetime depend on an execution context the browser
can discard.

## Live and local state

Omit the connection store's `sync` option for the normal live mode. Enbox uses
WebSocket transports for live sync and subscriptions and a periodic durable
settle pass to repair missed notifications.

- Use `records.observe()` for a bounded collection that must remain correct as
  records enter, change, or leave its filter.
- Use `records.subscribe()` for an incremental or append-only event stream.
- Use a one-shot `query()` for searches and snapshots.
- Use `ConnectionStore.subscribe()` for auth, sync, connectivity, facade
  replacement, and wallet-reapproval state.

An observed view can be `ready` with useful local records while `current` is
`false`. Render the local data and show its freshness instead of replacing the
live path with application polling.

## Session and storage lifetime

Create one manifest-backed `ConnectionStore` for the application and keep it
for the application lifetime. Use `BrowserConnectHandler`, call `initialize()`
once at startup, and invoke `connect()` directly from a user action when a
wallet is needed. Configure `monitor: { autoRefresh: {} }` for delegated grant
renewal.

A refresh can publish a replacement `enbox` facade. Bind views and
subscriptions to the current facade and recreate them when it changes. The
ecosystem wallet has provider responsibilities that require lower-level auth
ownership; ordinary dapps should copy Notesd's connection-store boundary, not
the wallet's internals.

Keep the browser Level stack, which resolves to `browser-level` over IndexedDB.
It persists the local replica and coordinates same-origin access across tabs
and workers. In-memory and server SQL stores do not provide that browser
lifecycle.

## DWeb fetch boundary

Every browser dapp must register a service worker that calls
`activatePolyfills()`. The handler resolves a DRL's DID and DWN endpoint and
returns the addressed record as an ordinary `Response`. Without it, DRL-backed
images, media, links, and `fetch()` calls fail as ordinary network requests
while the rest of the SDK can appear healthy.

Use one application-owned worker for DRL interception and application-shell
precaching, and make it control the page before rendering. Current
browser-conditioned Enbox packages work in page and worker builds without
Enbox-specific Node-global, `process`, dynamic-import, or IIFE workarounds.

The canonical guide owns the exact Vite configuration, boot order, hosting
headers, and end-to-end completion gate.
