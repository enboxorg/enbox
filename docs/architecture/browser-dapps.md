# Browser dapp architecture

This is the runtime contract for an Enbox browser dapp. The public
[`Build a browser dapp`](../../apps/docs/content/docs/guides/browser-dapp.mdx)
guide contains the copyable Vite and React implementation.

## Runtime ownership

An Enbox dapp has two browser execution contexts with different lifetimes:

```text
page
  UI
  one ConnectionStore
  AuthManager + Enbox facade
  records.observe() / records.subscribe()
  live WebSocket sync and subscriptions
           │
           │ ordinary fetch / <img src> for DRLs
           ▼
service worker
  precached application shell
  activatePolyfills() DRL fetch interception and cache
           │
           │ HTTPS and WebSocket
           ▼
DWN servers, wallet connect, and DID resolution
```

The page owns identity, session state, typed APIs, live record views, and the
WebSocket-backed sync engine. The service worker owns the fetch boundary: it
serves the offline application shell and resolves Decentralized Resource
Locators (DRLs) into ordinary responses.

Do not move the connection store or its sockets into a service worker. Browsers
may terminate a worker between events, so it is not a durable host for an open
WebSocket. When a page is suspended, the SDK reconnects and reconciles its
durable feeds when it resumes.

## WebSocket first and local first

Omit the connection store's `sync` option for the normal live mode. Enbox uses
pooled WebSocket transports for live sync and subscriptions, with HTTP where a
request/response or larger transfer is a better fit. Its periodic durable-feed
settle pass is recovery for dropped notifications, not an application polling
API.

Application state should follow the same model:

- Use `records.observe()` for a bounded collection that must stay correct as
  records enter, change, or leave a filter.
- Use `records.subscribe()` for an incremental or append-only event stream.
- Use `ConnectionStore.subscribe()` for auth, replacement facades, sync
  currentness, connectivity, and wallet reapproval state.
- Use a one-shot `query()` for searches and snapshots, not on a timer to keep
  the main UI current.

Observed local replicas remain usable while offline. Their `current` field is
separate from `status`: a view can be `ready` with cached or locally written
records while `current` is `false`. Render the data and show its freshness;
do not replace the view with an app-level refresh loop.

A refreshed delegated session replaces the `ConnectionStore`'s `enbox`
facade. Bind every view and subscription to that facade's lifetime and recreate
them when the snapshot publishes a different facade.

## The service worker is required

`activatePolyfills()` from `@enbox/browser` installs the DWeb fetch handler
inside a service worker. A DRL addresses a record through a DID, for example:

```text
http://dweb/did:dht:abc.../protocols/read/<encoded-protocol>/avatar
```

The handler resolves the DID's `DecentralizedWebNode` endpoints, fetches the
record, and returns an ordinary `Response`. This lets `<img>`, `<video>`, and
`fetch()` consume DWN resources without application plumbing. Its optional
cache can return a previously fetched resource while offline.

Without the worker, the browser sends a DRL as an ordinary network request and
it fails outside the SDK. Connect, typed records, and sync can continue to work,
so a build or CRUD smoke test does not expose the omission.

Register the worker before rendering the application, wait for
`navigator.serviceWorker.ready`, and wait until it controls the page. The
worker's call to `activatePolyfills()` uses `skipWaiting()` and `clients.claim()`
so a first visit can become controlled without asking the user to reload.

Use an application-owned worker built with `vite-plugin-pwa` `injectManifest`.
It combines Workbox precaching with the Enbox DRL handler and gives the app one
explicit update lifecycle. The current browser-conditioned `@enbox/*` bundles
work in both the page and the worker; do not add Enbox-specific `process`,
`global`, Node standard-library, dynamic-import, or IIFE workarounds.

## Authentication and session lifetime

A dapp delegates authentication to a wallet:

1. Define every typed protocol in one application manifest.
2. Create one `ConnectionStore` with `BrowserConnectHandler`.
3. Call `initialize()` once to restore a saved session.
4. Call `connect()` from a user action when no usable session exists.
5. Read the active API only from the current snapshot's `enbox` property.
6. Call `disconnect()` on sign-out and `dispose()` only when the application
   store is permanently released.

Wallet approvals issue one-hour grants by default. Configure
`monitor: { autoRefresh: {} }`; the store derives the refresh request from the
same manifest. If a grant is revoked, protocol coverage changes, or silent
refresh cannot complete, render a reconnect action when
`walletReapprovalRequired` is true. Do not match SDK error-message text.

The ecosystem wallet is an identity and consent provider, so its internal
`AuthManager` ownership is intentionally more involved than a dapp's. New
dapps should copy the connection-store boundary used by `notesd`, not the
wallet's provider internals.

## Storage

In browsers, `level` resolves to `browser-level` over IndexedDB. Keep that
default. It coordinates concurrent writes from same-origin tabs and workers and
persists the local replica that makes the app useful offline. In-memory stores
lose that behavior, and the server-side SQL store is not a browser substitute.

Use one stable `dataPath` and one connection store for an application. Separate
stores targeting the same path do not coordinate lifecycle actions or
snapshots.

## Hosting

The application is an SPA with a root-scoped worker:

- serve navigation fallbacks from the precached application shell;
- serve `/sw.js` with `Cache-Control: no-cache, no-store, must-revalidate`;
- keep hashed assets immutable;
- allow the app's HTTPS and WSS endpoints in `connect-src`;
- use `Referrer-Policy: strict-origin-when-cross-origin` so the wallet can
  identify the requesting origin without receiving a path;
- do not set `Cross-Origin-Opener-Policy: same-origin`, which severs the
  cross-origin popup's opener and breaks the wallet `postMessage` return path.
  If cross-origin isolation is required, start from `same-origin-allow-popups`
  and test the whole connect ceremony.

Service workers require HTTPS, except on localhost.

## Verification gate

Run the checks against a production build and preview server. A new dapp is not
complete until all of these work:

- the worker reaches `activated` and
  `navigator.serviceWorker.controller` is non-null on the first visit;
- a real DRL renders through the worker, and a cached DRL remains readable
  offline;
- a wallet connection approves the manifest and survives a page reload;
- `monitor: { autoRefresh: {} }` is enabled and the UI has a reconnect state;
- a write appears in an observed collection without a polling timer or manual
  refresh;
- a change from another connected tab or device arrives over the live path;
- existing local data renders offline, an offline write remains visible, and
  reconnect eventually makes the view current;
- every view and subscription closes on sign-out or facade replacement;
- the deployed headers preserve the popup relationship and prevent `/sw.js`
  caching.
