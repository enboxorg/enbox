# Browser dapp architecture

This document defines the browser runtime boundary. Keep copyable setup,
deployment, and verification instructions in the public
[`Build a browser dapp`](../../apps/docs/content/docs/guides/browser-dapp.mdx)
guide so developers have one implementation recipe.

## Package boundary

The published Enbox SDKs are framework-independent. `@enbox/api` owns protocol
operations, sessions, observations, and commands. `@enbox/browser` adds browser
facilities such as wallet popups, service workers, and URL handling. Neither
package contains React hooks, components, React types, or React dependencies.
SDK behavior must not depend on React mounting, rendering, or effect timing.

React providers, hooks, and component lifecycle integration belong in the
separate [`@enbox/react` repository](https://github.com/enboxorg/enbox-react).
Its bindings consume the same `getSnapshot()` and `subscribe()` contracts as
plain JavaScript and other clients. Server-rendering contracts are outside the
dapp runtime model.

## Runtime ownership

An Enbox dapp has two browser execution contexts with different lifetimes:

```text
page
  UI
  one application runtime
    native ConnectionStore and Enbox facade
    session-owned feature stores and observations
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

The page owns the runtime, session, typed APIs, live views, and sockets. The
service worker owns the fetch boundary for Decentralized Resource Locators (DRLs) and
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

- Define named owned collections and domain commands with `defineStore()`.
  Components and controllers resolve the same feature instance from the runtime;
  equivalent selections share native views and command progress.
- Own native observations with the same feature `observe()` factory, including
  context-bound shared records. Use native views directly for custom ownership.
- Use `records.subscribe()` for an incremental or append-only event stream.
- Use a one-shot `query()` for searches and snapshots.
- Use `ConnectionStore.subscribe()` for auth, sync, connectivity, facade
  replacement, and wallet-reapproval state.

An observed view can be `ready` with useful local records while `current` is
`false`. Render the local data and show its freshness instead of replacing the
live path with application polling.

## Session and storage lifetime

Pass feature definitions to browser `createApplication({ stores, wallet, connection })`.
It derives the manifest and constructs the native connection. Keep that runtime and
connection for the page's application lifetime. The runtime owns feature
instances and cleanup; `runtime.connection` owns native auth, sync state, and
connection actions. It remains the sole connection state model.

Use `BrowserConnectHandler`, prepare worker control before startup, and invoke
wallet approval directly from a user action. `EnboxProvider application={runtime}`
initializes by default; headless hosts call `runtime.initialize()` themselves.
Configure `monitor: { autoRefresh: {} }` for delegated grant renewal.

Session or facade replacement retires captured feature controls and releases
their resources. React's `useFeature` follows that replacement; `useStore`
retains each observed store after commit and releases it on cleanup.
Headless consumers use explicit leases. Native views opened outside feature
stores retain their caller-owned lifetime and must be rebound and closed by
that caller when authority changes.

The ecosystem wallet has provider responsibilities that require lower-level
auth ownership; ordinary dapps should follow the runtime/connection boundary in
[`Build a browser dapp`](../../apps/docs/content/docs/guides/browser-dapp.mdx).

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
`activatePolyfills()` claims clients after activation; the application decides
when to activate a waiting update and reload, after completing pending work.

The canonical guide owns the exact Vite configuration, boot order, hosting
headers, and end-to-end completion gate.
